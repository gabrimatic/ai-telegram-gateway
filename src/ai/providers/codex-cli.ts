import { spawn, ChildProcess } from "child_process";
import * as readline from "readline";
import { env } from "../../env";
import { getConfig, ModelName } from "../../config";
import { info, error as logError, debug } from "../../logger";
import { CircuitBreaker, CircuitBreakerError } from "../../circuit-breaker";
import type { AIBackend, AIResponse, AIStats } from "../types";

// Default Codex model
const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";

// Health constants
const STUCK_THRESHOLD_MS = 180000; // 3 min for codex (can be slower)
const MAX_RESPONSE_BUFFER_SIZE = 1024 * 1024;

// JSONL message types from Codex
interface CodexStreamMessage {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  message?: string;
  error?: {
    message?: string;
  };
}

// Virtual session tracking
let currentModel: ModelName = DEFAULT_CODEX_MODEL as ModelName;
let sessionId = `codex-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
let sessionStartedAt = new Date();
let messageCount = 0;
let recentFailures = 0;
let isProcessing = false;
let lastActivityTime = Date.now();
let currentProcess: ChildProcess | null = null;

// Circuit breaker
const codexCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  recoveryTimeoutMs: 120000,
  successThreshold: 2,
});

function resetSession(): void {
  sessionId = `codex-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  sessionStartedAt = new Date();
  messageCount = 0;
  recentFailures = 0;
}

export async function runCodex(
  message: string,
  onChunk?: (text: string) => Promise<void>
): Promise<AIResponse> {
  const breakerState = codexCircuitBreaker.getState();
  if (breakerState === "open") {
    return {
      success: false,
      response: "",
      error: "Codex circuit breaker is open due to repeated failures. Try again later.",
    };
  }

  messageCount++;
  isProcessing = true;
  lastActivityTime = Date.now();

  try {
    const result = await codexCircuitBreaker.execute(async () => {
      return await executeCodex(message, onChunk);
    });
    if (!result.success) {
      throw new Error(result.error || "Codex request failed");
    }
    return result;
  } catch (err) {
    if (err instanceof CircuitBreakerError) {
      return {
        success: false,
        response: "",
        error: "Codex circuit breaker is open due to repeated failures. Try again later.",
      };
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    recentFailures++;
    return {
      success: false,
      response: "",
      error: errorMsg,
    };
  } finally {
    isProcessing = false;
    currentProcess = null;
  }
}

async function executeCodex(
  message: string,
  onChunk?: (text: string) => Promise<void>
): Promise<AIResponse> {
  const codexPath = env.CODEX_BIN;
  const requestStartTime = Date.now();

  return new Promise<AIResponse>((resolve) => {
    let resolved = false;
    let responseBuffer = "";
    let errorMessage = "";

    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    const timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      logError("codex", "request_timeout", { timeoutMs: TIMEOUT_MS });
      if (proc) {
        proc.kill("SIGKILL");
      }
      resolve({
        success: false,
        response: "",
        error: `Request timed out after ${TIMEOUT_MS / 1000} seconds`,
      });
    }, TIMEOUT_MS);

    debug("codex", "starting_exec", { model: currentModel, messageLength: message.length });

    const proc = spawn(
      codexPath,
      [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-m",
        currentModel,
        message,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: env.TG_WORKING_DIR,
      }
    );

    currentProcess = proc;

    const rl = readline.createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
    });

    rl.on("line", async (line) => {
      lastActivityTime = Date.now();
      try {
        const msg: CodexStreamMessage = JSON.parse(line);
        debug("codex", "stream_message", { type: msg.type });

        // Agent message with text content
        if (msg.type === "item.completed" && msg.item?.type === "agent_message" && msg.item?.text) {
          const text = msg.item.text;
          if (responseBuffer.length > 0 && !responseBuffer.endsWith('\n')) {
            responseBuffer += '\n\n';
            if (onChunk) await onChunk('\n\n');
          }
          if (responseBuffer.length < MAX_RESPONSE_BUFFER_SIZE) {
            responseBuffer += text;
          }
          if (onChunk) {
            await onChunk(text);
          }
        }

        // Error events
        if (msg.type === "error") {
          errorMessage = msg.message || "Unknown Codex error";
        }

        if (msg.type === "turn.failed") {
          errorMessage = msg.error?.message || errorMessage || "Codex turn failed";
        }

        // Turn completed = done
        if (msg.type === "turn.completed") {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            const durationMs = Date.now() - requestStartTime;
            if (responseBuffer.trim()) {
              resolve({
                success: true,
                response: responseBuffer.trim(),
                durationMs,
              });
            } else if (errorMessage) {
              resolve({
                success: false,
                response: "",
                error: errorMessage,
                durationMs,
              });
            } else {
              resolve({
                success: false,
                response: "",
                error: "Codex returned empty response",
                durationMs,
              });
            }
          }
        }
      } catch {
        // Not JSON, ignore (stderr noise that leaked to stdout)
      }
    });

    proc.stderr?.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        debug("codex", "stderr", { message: msg.substring(0, 200) });
      }
    });

    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        const durationMs = Date.now() - requestStartTime;
        if (responseBuffer.trim()) {
          // Process exited but we got content
          resolve({
            success: true,
            response: responseBuffer.trim(),
            durationMs,
          });
        } else {
          resolve({
            success: false,
            response: "",
            error: errorMessage || `Codex process exited with code ${code}`,
            durationMs,
          });
        }
      }
      rl.close();
    });

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        logError("codex", "process_error", { error: err.message });
        resolve({
          success: false,
          response: "",
          error: `Codex process error: ${err.message}`,
        });
      }
    });

    // Close stdin immediately since we pass the prompt as an argument
    proc.stdin?.end();
  });
}

export function stopCodex(): void {
  if (currentProcess) {
    debug("codex", "stopping_process");
    currentProcess.kill("SIGKILL");
    currentProcess = null;
  }
  isProcessing = false;
}

export function isCodexAlive(): boolean {
  return true; // Always ready - no persistent process needed
}

export function isCodexSessionStuck(): boolean {
  if (!isProcessing) return false;
  return Date.now() - lastActivityTime > STUCK_THRESHOLD_MS;
}

export function isCodexSessionRestarting(): boolean {
  return false; // No persistent session to restart
}

export async function restartCodexSession(): Promise<void> {
  stopCodex();
  resetSession();
  info("codex", "session_reset", { sessionId });
}

export function getCurrentCodexModel(): ModelName {
  return currentModel;
}

// Map user-friendly aliases to actual Codex model IDs
const CODEX_MODEL_ALIASES: Record<string, string> = {
  codex: DEFAULT_CODEX_MODEL,
};

export async function setCodexModel(model: ModelName): Promise<void> {
  const resolved = CODEX_MODEL_ALIASES[model] ?? model;
  if (resolved === currentModel) return;
  currentModel = resolved as ModelName;
  info("codex", "model_changed", { model: resolved });
  resetSession();
}

export function getCodexStats(): AIStats | null {
  return {
    sessionId,
    startedAt: sessionStartedAt,
    messageCount,
    durationSeconds: Math.floor((Date.now() - sessionStartedAt.getTime()) / 1000),
    recentFailures,
    isHealthy: !isProcessing || (Date.now() - lastActivityTime < STUCK_THRESHOLD_MS),
    lastActivityMs: Date.now() - lastActivityTime,
    model: currentModel,
  };
}

export function hasCodexProcessedMessages(): boolean {
  return messageCount > 0;
}

export function getCodexSessionId(): string {
  return sessionId;
}

export function getCodexCircuitBreakerState(): string {
  return codexCircuitBreaker.getState();
}

export function resetCodexCircuitBreaker(): void {
  codexCircuitBreaker.reset();
  info("codex", "circuit_breaker_reset");
}

export function createCodexCliBackend(): AIBackend {
  // Don't override currentModel here -- it will be set by switchModel() or setModel()
  // after creation. Only set it if no model has been set yet.
  if (currentModel === DEFAULT_CODEX_MODEL) {
    // Keep default codex model
  }

  return {
    providerName: "codex-cli",
    run: runCodex,
    restartSession: restartCodexSession,
    stopSession: stopCodex,
    isSessionAlive: isCodexAlive,
    isSessionStuck: isCodexSessionStuck,
    isSessionRestarting: isCodexSessionRestarting,
    getStats: getCodexStats,
    setModel: setCodexModel,
    getCurrentModel: getCurrentCodexModel,
    hasProcessedMessages: hasCodexProcessedMessages,
    getSessionId: getCodexSessionId,
    getCircuitBreakerState: getCodexCircuitBreakerState,
    resetCircuitBreaker: resetCodexCircuitBreaker,
  };
}
