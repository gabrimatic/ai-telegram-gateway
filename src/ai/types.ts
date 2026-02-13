import type { ModelName } from "../config";

export type AIProviderName = "claude-cli" | "codex-cli" | "stub" | (string & {});

export interface AIResponse {
  success: boolean;
  response: string;
  error?: string;
  durationMs?: number;
  mcpErrors?: string[];
  sessionRestarted?: boolean;
}

export interface AIStats {
  sessionId: string;
  startedAt: Date;
  messageCount: number;
  durationSeconds: number;
  recentFailures: number;
  isHealthy: boolean;
  lastActivityMs: number;
  model: ModelName;
  lastInputTokens?: number;
  lastOutputTokens?: number;
  lastContextWindow?: number;
  sessionInputTokensTotal?: number;
  sessionOutputTokensTotal?: number;
  // Legacy compatibility fields. These currently represent last turn values.
  totalInputTokens?: number;
  totalOutputTokens?: number;
  contextWindow?: number;
}

export interface AIBackend {
  providerName: AIProviderName;
  supportsContextSessions?: boolean;
  run: (
    message: string,
    onChunk?: (text: string) => Promise<void>,
    contextKey?: string
  ) => Promise<AIResponse>;
  restartSession: (contextKey?: string) => Promise<void>;
  stopSession: (contextKey?: string) => void;
  isSessionAlive: (contextKey?: string) => boolean;
  isSessionStuck: (contextKey?: string) => boolean;
  isSessionRestarting: (contextKey?: string) => boolean;
  getStats: (contextKey?: string) => AIStats | null;
  setModel: (model: ModelName) => Promise<void>;
  getCurrentModel: () => ModelName;
  hasProcessedMessages: (contextKey?: string) => boolean;
  getSessionId: (contextKey?: string) => string;
  getCircuitBreakerState: () => string;
  resetCircuitBreaker: () => void;
}
