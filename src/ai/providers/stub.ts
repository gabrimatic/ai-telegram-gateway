import { getConfig } from "../../config";
import type { AIBackend, AIResponse, AIStats } from "../types";

export function createStubBackend(): AIBackend {
  const config = getConfig();
  let startedAt = new Date();
  let messageCount = 0;
  let recentFailures = 0;
  let lastActivityTime = Date.now();
  let currentModel = config.defaultModel;
  let sessionId = `stub-${Date.now()}`;

  const buildStats = (): AIStats => {
    const lastActivityMs = Date.now() - lastActivityTime;
    return {
      sessionId,
      startedAt,
      messageCount,
      durationSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      recentFailures,
      isHealthy: true,
      lastActivityMs,
      model: currentModel,
    };
  };

  const makeError = (): AIResponse => ({
    success: false,
    response: "",
    error: "AI provider is not configured. Set aiProvider in config/gateway.json.",
  });

  return {
    providerName: "stub",
    supportsContextSessions: false,
    async run(
      _message: string,
      _onChunk?: (text: string) => Promise<void>,
      _contextKey?: string
    ): Promise<AIResponse> {
      messageCount++;
      recentFailures++;
      lastActivityTime = Date.now();
      return makeError();
    },
    async restartSession(_contextKey?: string): Promise<void> {
      startedAt = new Date();
      messageCount = 0;
      recentFailures = 0;
      lastActivityTime = Date.now();
      sessionId = `stub-${Date.now()}`;
    },
    stopSession(_contextKey?: string): void {
      // No-op for stub backend.
    },
    isSessionAlive(_contextKey?: string): boolean {
      return false;
    },
    isSessionStuck(_contextKey?: string): boolean {
      return false;
    },
    isSessionRestarting(_contextKey?: string): boolean {
      return false;
    },
    getStats(_contextKey?: string): AIStats | null {
      return buildStats();
    },
    async setModel(model): Promise<void> {
      currentModel = model;
    },
    getCurrentModel() {
      return currentModel;
    },
    hasProcessedMessages(_contextKey?: string): boolean {
      return messageCount > 0;
    },
    getSessionId(_contextKey?: string): string {
      return sessionId;
    },
    getCircuitBreakerState(): string {
      return "closed";
    },
    resetCircuitBreaker(): void {
      // No-op for stub backend.
    },
  };
}
