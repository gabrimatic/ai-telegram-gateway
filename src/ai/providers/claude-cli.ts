import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import { env } from "../../env";
import { getConfig, ModelName } from "../../config";
import { info, warn, error as logError, debug } from "../../logger";
import { cleanupSessionFiles } from "../../files";
import { CircuitBreaker, CircuitBreakerError } from "../../circuit-breaker";
import { sendAdminAlert } from "../../alerting";
import { isAuthFailureText } from "../auth-failure";
import { isDegradedMode, enterDegradedMode } from "../auth-check";
import type { AIBackend, AIResponse, AIStats } from "../types";

interface ContentBlock {
  type: string;
  text?: string;
}

interface StreamMessageUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface StreamMessageModelUsage {
  [model: string]: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    contextWindow?: number;
  };
}

interface StreamMessage {
  type: string;
  content?: string;
  message?: {
    content?: ContentBlock[] | string;
  };
  result?: string;
  usage?: StreamMessageUsage;
  modelUsage?: StreamMessageModelUsage;
}

export type SessionStats = AIStats;

// Health check constants
const HEALTH_CHECK_INTERVAL_MS = 30000; // Check every 30s
const STUCK_THRESHOLD_MS = 120000; // Consider stuck if no activity for 2 min while processing
const MAX_RESPONSE_BUFFER_SIZE = 1024 * 1024; // 1MB cap on response buffer

class ClaudeSession extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private responseBuffer: string = "";
  private currentResolve: ((response: AIResponse) => void) | null = null;
  private currentOnChunk: ((text: string) => Promise<void>) | null = null;
  private isProcessing: boolean = false;
  private messageQueue: Array<{
    message: string;
    resolve: (response: AIResponse) => void;
    onChunk?: (text: string) => Promise<void>;
  }> = [];
  private sessionId: string;
  private startedAt: Date;
  private messageCount: number = 0;
  private recentFailures: number = 0;
  private currentMcpErrors: string[] = [];
  private requestStartTime: number = 0;
  private lastActivityTime: number = Date.now();
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private authFailureDetected: boolean = false;
  private model: ModelName;
  private totalInputTokens: number = 0; // Legacy: last turn input tokens
  private totalOutputTokens: number = 0; // Legacy: last turn output tokens
  private contextWindow: number = 200000; // Legacy: last known context window
  private lastInputTokens: number | undefined = undefined;
  private lastOutputTokens: number | undefined = undefined;
  private lastContextWindow: number | undefined = undefined;
  private sessionInputTokensTotal: number = 0;
  private sessionOutputTokensTotal: number = 0;

  constructor(model: ModelName) {
    super();
    this.sessionId = this.generateSessionId();
    this.startedAt = new Date();
    this.model = model;
    this.startHealthCheck();
  }

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      this.checkHealth();
    }, HEALTH_CHECK_INTERVAL_MS);
    // Don't prevent process exit
    this.healthCheckTimer.unref();
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private checkHealth(): void {
    if (!this.isProcessing) return;

    const timeSinceActivity = Date.now() - this.lastActivityTime;
    if (timeSinceActivity > STUCK_THRESHOLD_MS) {
      logError("claude", "session_stuck", {
        sessionId: this.sessionId,
        timeSinceActivityMs: timeSinceActivity,
      });
      this.emit("stuck");
    }
  }

  private updateActivity(): void {
    this.lastActivityTime = Date.now();
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  async start(): Promise<void> {
    if (this.proc) return;

    const config = getConfig();
    const claudePath = env.CLAUDE_BIN;

    debug("claude", "starting_session", { sessionId: this.sessionId, model: this.model });

    const filteredEnv = { ...process.env };
    delete filteredEnv.CLAUDECODE;
    delete filteredEnv.CLAUDE_CODE_ENTRYPOINT;
    delete filteredEnv.INIT_CWD;
    delete filteredEnv.PWD;
    delete filteredEnv.OLDPWD;

    this.proc = spawn(
      claudePath,
      [
        "--print",
        "--verbose",
        "--dangerously-skip-permissions",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        this.model,
        "--mcp-config",
        config.mcpConfigPath,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: env.TG_WORKING_DIR,
        env: filteredEnv,
      }
    );

    this.rl = readline.createInterface({
      input: this.proc.stdout!,
      crlfDelay: Infinity,
    });

    this.rl.on("line", (line) => {
      this.handleLine(line).catch((err) => {
        logError("claude", "handle_line_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    // Handle readline errors (e.g., stream destroyed unexpectedly)
    this.rl.on("error", (err) => {
      logError("claude", "readline_error", {
        error: err instanceof Error ? err.message : String(err),
        sessionId: this.sessionId,
      });
    });

    this.proc.stderr?.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        // Only log first 500 chars of stderr to prevent log flooding
        debug("claude", "stderr", { message: msg.substring(0, 500) });
        // Capture MCP-related errors (capped to prevent unbounded growth)
        if (/mcp|tool|connection|refused|ECONNREFUSED/i.test(msg)) {
          if (this.currentMcpErrors.length < 50) {
            this.currentMcpErrors.push(msg.substring(0, 200));
          }
        }
      }
    });

    this.proc.on("close", (code) => {
      info("claude", "process_exited", { code, sessionId: this.sessionId });
      this.proc = null;
      if (this.rl) {
        this.rl.close();
        this.rl = null;
      }
      this.currentOnChunk = null;
      if (this.currentResolve) {
        this.currentResolve({
          success: false,
          response: "",
          error: `Process exited unexpectedly with code ${code}`,
        });
        this.currentResolve = null;
      }
      // Drain the message queue with error responses
      while (this.messageQueue.length > 0) {
        const queued = this.messageQueue.shift()!;
        queued.resolve({
          success: false,
          response: "",
          error: `Process exited unexpectedly with code ${code}`,
        });
      }
      this.isProcessing = false;
    });

    this.proc.on("error", (err) => {
      logError("claude", "process_error", { error: err.message });
      if (this.currentResolve) {
        this.currentResolve({
          success: false,
          response: "",
          error: `Process error: ${err.message}`,
        });
        this.currentResolve = null;
      }
    });

    info("claude", "session_started", { sessionId: this.sessionId });
  }

  private async handleLine(line: string): Promise<void> {
    this.updateActivity();
    try {
      const msg: StreamMessage = JSON.parse(line);

      // Debug: log all message types with structure
      debug("claude", "stream_message", {
        type: msg.type,
        hasMessageContent: !!msg.message?.content,
        hasContent: !!msg.content,
        hasResult: !!msg.result,
        keys: Object.keys(msg)
      });

      // Collect assistant message content (content is an array of blocks)
      // Also emit as chunk for streaming handler
      if (msg.type === "assistant" && msg.message?.content) {
        const content = msg.message.content;
        let textContent = "";
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              textContent += block.text;
            }
          }
        } else if (typeof content === "string") {
          textContent = content;
        }
        if (textContent) {
          const needsSeparator = this.responseBuffer.length > 0 && !this.responseBuffer.endsWith("\n");
          const separator = needsSeparator ? "\n\n" : "";
          const candidateBuffer = this.responseBuffer + separator + textContent;
          this.markAuthFailureIfDetected(candidateBuffer);

          // Add paragraph break between assistant turns if buffer has content
          // that doesn't already end with newlines
          if (needsSeparator) {
            this.responseBuffer += separator;
            if (!this.authFailureDetected && this.currentOnChunk) {
              await this.currentOnChunk(separator);
            }
          }
          // Cap buffer size to prevent unbounded memory growth
          if (this.responseBuffer.length < MAX_RESPONSE_BUFFER_SIZE) {
            this.responseBuffer += textContent;
          }
          // Emit full content as a chunk for streaming callback
          if (!this.authFailureDetected && this.currentOnChunk) {
            await this.currentOnChunk(textContent);
          }
        }
      }

      // Content block delta with text - always accumulate and emit chunk if callback exists
      if (msg.type === "content_block_delta" && msg.content) {
        this.markAuthFailureIfDetected(this.responseBuffer + msg.content);
        if (this.responseBuffer.length < MAX_RESPONSE_BUFFER_SIZE) {
          this.responseBuffer += msg.content;
        }
        if (!this.authFailureDetected && this.currentOnChunk) {
          await this.currentOnChunk(msg.content);
        }
      }

      // Result message indicates completion
      if (msg.type === "result") {
        // Capture token usage
        if (msg.usage) {
          const inputTokens = (msg.usage.input_tokens || 0) +
            (msg.usage.cache_creation_input_tokens || 0) +
            (msg.usage.cache_read_input_tokens || 0);
          const outputTokens = msg.usage.output_tokens || 0;

          this.lastInputTokens = inputTokens;
          this.lastOutputTokens = outputTokens;
          this.sessionInputTokensTotal += inputTokens;
          this.sessionOutputTokensTotal += outputTokens;

          // Legacy compatibility fields.
          this.totalInputTokens = inputTokens;
          this.totalOutputTokens = outputTokens;
        } else {
          // Avoid stale "last turn" values when the provider omits usage.
          this.lastInputTokens = undefined;
          this.lastOutputTokens = undefined;
          this.totalInputTokens = 0;
          this.totalOutputTokens = 0;
        }

        this.lastContextWindow = undefined;
        if (msg.modelUsage) {
          for (const modelInfo of Object.values(msg.modelUsage)) {
            if (modelInfo.contextWindow) {
              this.contextWindow = modelInfo.contextWindow;
              this.lastContextWindow = modelInfo.contextWindow;
              break;
            }
          }
        }

        const finalResponse = msg.result || this.responseBuffer;
        const durationMs = Date.now() - this.requestStartTime;
        if (this.currentResolve) {
          if (this.authFailureDetected || isAuthFailureText(finalResponse)) {
            this.markAuthFailureIfDetected(finalResponse);
            this.currentResolve({
              success: false,
              response: "",
              error: "AI backend authentication required. Please ask the admin to re-authenticate the CLI.",
              durationMs,
              mcpErrors: this.currentMcpErrors.length > 0 ? [...this.currentMcpErrors] : undefined,
            });
          } else {
            this.currentResolve({
              success: true,
              response: finalResponse.trim(),
              durationMs,
              mcpErrors: this.currentMcpErrors.length > 0 ? [...this.currentMcpErrors] : undefined,
            });
          }
          this.currentResolve = null;
        }
        this.responseBuffer = "";
        this.currentMcpErrors = [];
        this.currentOnChunk = null;
        this.isProcessing = false;
        this.authFailureDetected = false;
        this.processQueue();
      }
    } catch (err) {
      // Not JSON, ignore
    }
  }

  private processQueue(): void {
    if (this.isProcessing || this.messageQueue.length === 0) return;

    const next = this.messageQueue.shift()!;
    this.sendMessageInternal(next.message, next.resolve, next.onChunk);
  }

  private sendMessageInternal(
    message: string,
    resolve: (response: AIResponse) => void,
    onChunk?: (text: string) => Promise<void>
  ): void {
    if (!this.proc || !this.proc.stdin) {
      resolve({
        success: false,
        response: "",
        error: "AI session not started",
      });
      return;
    }

    this.isProcessing = true;
    this.currentResolve = resolve;
    this.currentOnChunk = onChunk || null;
    this.responseBuffer = "";
    this.currentMcpErrors = [];
    this.authFailureDetected = false;
    this.requestStartTime = Date.now();

    const inputMessage = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: message,
      },
      session_id: this.sessionId,
      parent_tool_use_id: null,
    });

    debug("claude", "sending_message", { length: message.length });
    this.proc.stdin.write(inputMessage + "\n", (err) => {
      if (err) {
        logError("claude", "stdin_write_error", { error: err.message });
        if (this.currentResolve) {
          this.currentResolve({
            success: false,
            response: "",
            error: `Failed to write to process stdin: ${err.message}`,
          });
          this.currentResolve = null;
          this.currentOnChunk = null;
          this.isProcessing = false;
        }
      }
    });
  }

  async sendMessage(
    message: string,
    onChunk?: (text: string) => Promise<void>
  ): Promise<AIResponse> {
    await this.start();
    this.messageCount++;

    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    return new Promise((resolve) => {
      let timeoutId: NodeJS.Timeout | null = null;
      let resolved = false;

      const wrappedResolve = (response: AIResponse) => {
        if (resolved) return;
        resolved = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        resolve(response);
      };

      timeoutId = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        logError("claude", "request_timeout", {
          sessionId: this.sessionId,
          timeoutMs: TIMEOUT_MS,
        });
        // Clear callback before killing to prevent further chunk processing
        this.currentOnChunk = null;
        // Force kill the process
        if (this.proc) {
          this.proc.kill("SIGKILL");
        }
        resolve({
          success: false,
          response: "",
          error: `Request timed out after ${TIMEOUT_MS / 1000} seconds`,
        });
      }, TIMEOUT_MS);

      if (this.isProcessing) {
        this.messageQueue.push({ message, resolve: wrappedResolve, onChunk });
      } else {
        this.sendMessageInternal(message, wrappedResolve, onChunk);
      }
    });
  }

  stop(): void {
    this.stopHealthCheck();
    if (this.proc) {
      debug("claude", "stopping_session", { sessionId: this.sessionId });
      this.proc.kill();
      this.proc = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    // Resolve any pending request
    if (this.currentResolve) {
      this.currentResolve({
        success: false,
        response: "",
        error: "Session stopped",
      });
      this.currentResolve = null;
    }
    // Drain the message queue
    while (this.messageQueue.length > 0) {
      const queued = this.messageQueue.shift()!;
      queued.resolve({
        success: false,
        response: "",
        error: "Session stopped",
      });
    }
    this.currentOnChunk = null;
    this.isProcessing = false;
  }

  forceKill(): void {
    this.stopHealthCheck();
    if (this.proc) {
      logError("claude", "force_killing_session", { sessionId: this.sessionId });
      this.proc.kill("SIGKILL");
      this.proc = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    // Clear any pending resolve
    if (this.currentResolve) {
      this.currentResolve({
        success: false,
        response: "",
        error: "Session force killed due to being stuck",
      });
      this.currentResolve = null;
    }
    // Drain the message queue
    while (this.messageQueue.length > 0) {
      const queued = this.messageQueue.shift()!;
      queued.resolve({
        success: false,
        response: "",
        error: "Session force killed due to being stuck",
      });
    }
    this.currentOnChunk = null;
    this.isProcessing = false;
  }

  isAlive(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  getStats(): SessionStats {
    const timeSinceActivity = Date.now() - this.lastActivityTime;
    const isHealthy = !this.isProcessing || timeSinceActivity < STUCK_THRESHOLD_MS;
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      messageCount: this.messageCount,
      durationSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      recentFailures: this.recentFailures,
      isHealthy,
      lastActivityMs: timeSinceActivity,
      model: this.model,
      lastInputTokens: this.lastInputTokens,
      lastOutputTokens: this.lastOutputTokens,
      lastContextWindow: this.lastContextWindow,
      sessionInputTokensTotal: this.sessionInputTokensTotal,
      sessionOutputTokensTotal: this.sessionOutputTokensTotal,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      contextWindow: this.contextWindow,
    };
  }

  getModel(): ModelName {
    return this.model;
  }

  isStuck(): boolean {
    if (!this.isProcessing) return false;
    return Date.now() - this.lastActivityTime > STUCK_THRESHOLD_MS;
  }

  incrementFailures(): void {
    this.recentFailures++;
  }

  resetFailures(): void {
    this.recentFailures = 0;
  }

  getMessageCount(): number {
    return this.messageCount;
  }

  private markAuthFailureIfDetected(text: string): void {
    // Once buffer has real content, stop checking for auth errors
    if (this.authFailureDetected || text.length > 200) return;
    if (!isAuthFailureText(text)) return;
    this.authFailureDetected = true;
    enterDegradedMode("Auth failure detected in session response");
    warn("claude", "auth_failure_detected", { sessionId: this.sessionId });
    void sendAdminAlert(
      "Gateway AI backend auth expired. Re-authenticate the CLI on the host to restore replies.",
      "critical",
      "service_down"
    );
  }
}

// Singleton session
let session: ClaudeSession | null = null;
let isRestarting = false;
let currentModel: ModelName = getConfig().defaultModel;

// Circuit breaker for Claude CLI calls
const claudeCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  recoveryTimeoutMs: 120000, // 2 minutes
  successThreshold: 2,
});

/**
 * Check if session is stuck and needs restart.
 * Returns true if session was restarted.
 */
async function ensureHealthySession(): Promise<boolean> {
  if (!session) return false;
  if (isRestarting) return true;

  if (session.isStuck()) {
    info("claude", "auto_restarting_stuck_session");
    isRestarting = true;
    try {
      session.forceKill();
      session = new ClaudeSession(currentModel);
      await session.start();
    } finally {
      isRestarting = false;
    }
    return true;
  }
  return false;
}

export async function runClaude(
  message: string,
  onChunk?: (text: string) => Promise<void>
): Promise<AIResponse> {
  // Reject immediately if auth is known to be broken
  if (isDegradedMode()) {
    return {
      success: false,
      response: "",
      error: "AI backend authentication is unavailable (degraded mode). Admin must re-authenticate the CLI.",
    };
  }

  // Check circuit breaker state
  const breakerState = claudeCircuitBreaker.getState();
  if (breakerState === "open") {
    return {
      success: false,
      response: "",
      error: "AI backend circuit breaker is open due to repeated failures. Try again later.",
    };
  }

  // Check if session is stuck before processing
  const wasRestarted = await ensureHealthySession();

  if (!session) {
    session = new ClaudeSession(currentModel);
  }

  try {
    const result = await claudeCircuitBreaker.execute(async () => {
      return await session!.sendMessage(message, onChunk);
    });
    if (wasRestarted) {
      result.sessionRestarted = true;
    }
    // Only count as success if the response was actually successful
    if (!result.success) {
      throw new Error(result.error || "AI request failed");
    }
    return result;
  } catch (err) {
    if (err instanceof CircuitBreakerError) {
      return {
        success: false,
        response: "",
        error: "AI backend circuit breaker is open due to repeated failures. Try again later.",
      };
    }
    // Return the original error response
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      response: "",
      error: errorMsg,
      sessionRestarted: wasRestarted,
    };
  }
}

export function isSessionStuck(): boolean {
  return session !== null && session.isStuck();
}

export function isSessionRestarting(): boolean {
  return isRestarting;
}

export function stopClaude(): void {
  if (session) {
    session.stop();
    session = null;
  }
}

export function isClaudeAlive(): boolean {
  return session !== null && session.isAlive();
}

export async function restartClaudeSession(): Promise<void> {
  const oldStats = session?.getStats();
  if (oldStats) {
    info("claude", "session_ending", {
      sessionId: oldStats.sessionId,
      messageCount: oldStats.messageCount,
      durationSeconds: oldStats.durationSeconds,
    });
    // Cleanup files from the old session
    cleanupSessionFiles(oldStats.sessionId);
  }

  stopClaude();
  session = new ClaudeSession(currentModel);
  await session.start();
}

export function getCurrentModel(): ModelName {
  return currentModel;
}

export async function setModel(model: ModelName): Promise<void> {
  if (model === currentModel && session) {
    return; // No change needed
  }
  currentModel = model;
  info("claude", "model_changed", { model });
  // Restart session with new model
  await restartClaudeSession();
}

export function getClaudeStats(): SessionStats | null {
  return session?.getStats() ?? null;
}

export function hasProcessedMessages(): boolean {
  return session !== null && session.getMessageCount() > 0;
}

export function incrementSessionFailures(): void {
  session?.incrementFailures();
}

export function resetSessionFailures(): void {
  session?.resetFailures();
}

export function getSessionId(): string {
  if (!session) {
    // Return a temporary session ID if no session exists yet
    return `temp-${Date.now()}`;
  }
  return session.getStats().sessionId;
}

export function getClaudeCircuitBreakerState(): string {
  return claudeCircuitBreaker.getState();
}

export function resetClaudeCircuitBreaker(): void {
  claudeCircuitBreaker.reset();
  info("claude", "circuit_breaker_reset");
}

export function createClaudeCliBackend(): AIBackend {
  return {
    providerName: "claude-cli",
    run: runClaude,
    restartSession: restartClaudeSession,
    stopSession: stopClaude,
    isSessionAlive: isClaudeAlive,
    isSessionStuck,
    isSessionRestarting,
    getStats: getClaudeStats,
    setModel,
    getCurrentModel,
    hasProcessedMessages,
    getSessionId,
    getCircuitBreakerState: getClaudeCircuitBreakerState,
    resetCircuitBreaker: resetClaudeCircuitBreaker,
  };
}
