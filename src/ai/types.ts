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
}

export interface AIBackend {
  providerName: AIProviderName;
  run: (message: string, onChunk?: (text: string) => Promise<void>) => Promise<AIResponse>;
  restartSession: () => Promise<void>;
  stopSession: () => void;
  isSessionAlive: () => boolean;
  isSessionStuck: () => boolean;
  isSessionRestarting: () => boolean;
  getStats: () => AIStats | null;
  setModel: (model: ModelName) => Promise<void>;
  getCurrentModel: () => ModelName;
  hasProcessedMessages: () => boolean;
  getSessionId: () => string;
  getCircuitBreakerState: () => string;
  resetCircuitBreaker: () => void;
}
