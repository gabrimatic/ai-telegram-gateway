import { info, warn } from "../logger";
import { DEFAULT_AI_PROVIDER, getConfiguredProviderName } from "../provider";
import type { AIBackend, AIProviderName, AIResponse, AIStats } from "./types";
import type { ModelName } from "../config";
import { createClaudeCliBackend } from "./providers/claude-cli";
import { createCodexCliBackend } from "./providers/codex-cli";
import { createStubBackend } from "./providers/stub";

// --- Provider Registry ---

const PROVIDERS: Record<string, () => AIBackend> = {
  "claude-cli": createClaudeCliBackend,
  "codex-cli": createCodexCliBackend,
  stub: createStubBackend,
};

let activeBackend: AIBackend | null = null;
let activeProvider: AIProviderName | null = null;

export function registerAIProvider(providerName: AIProviderName, factory: () => AIBackend): void {
  PROVIDERS[providerName] = factory;
  if (activeProvider === providerName) {
    activeBackend = null;
  }
}

// --- Model-to-Provider mapping ---
// Maps model names to the provider that handles them.
// Extensible: add new models here when new providers arrive.

const MODEL_PROVIDER_MAP: Record<string, AIProviderName> = {
  haiku: "claude-cli",
  opus: "claude-cli",
  sonnet: "claude-cli",
  codex: "codex-cli",
  "gpt-5.3-codex": "codex-cli",
};

// User-facing model names (shown in /model command). Internal aliases like
// "gpt-5.3-codex" are accepted but not surfaced in the UI.
const USER_FACING_MODELS: string[] = ["haiku", "opus", "sonnet", "codex"];

export function getProviderForModel(model: ModelName): AIProviderName | null {
  return MODEL_PROVIDER_MAP[model] ?? null;
}

export function registerModelProvider(model: string, provider: AIProviderName): void {
  MODEL_PROVIDER_MAP[model] = provider;
}

export function getAvailableModels(): string[] {
  return USER_FACING_MODELS;
}

export function isValidModel(model: string): boolean {
  return model in MODEL_PROVIDER_MAP;
}

export function getModelsForProvider(provider: AIProviderName): string[] {
  return Object.entries(MODEL_PROVIDER_MAP)
    .filter(([, p]) => p === provider)
    .map(([m]) => m);
}

// --- Provider resolution ---

function resolveProviderName(): AIProviderName {
  const provider = getConfiguredProviderName() as AIProviderName;
  if (!PROVIDERS[provider]) {
    warn("ai", "unknown_provider", { provider });
    return DEFAULT_AI_PROVIDER;
  }
  return provider;
}

function getBackend(): AIBackend {
  const provider = activeProvider || resolveProviderName();
  if (!activeBackend || activeProvider !== provider) {
    activeBackend = PROVIDERS[provider]();
    activeProvider = provider;
  }
  return activeBackend;
}

// --- Provider switching ---

/**
 * Switch to a different provider. Fully terminates the current session
 * before creating the new one. Use this when changing providers (e.g. claude -> codex).
 */
export async function switchProvider(newProvider: AIProviderName): Promise<void> {
  if (!PROVIDERS[newProvider]) {
    throw new Error(`Unknown provider: ${newProvider}`);
  }

  const oldProvider = activeProvider;

  // Terminate old session completely
  if (activeBackend) {
    info("ai", "switching_provider", { from: oldProvider, to: newProvider });
    activeBackend.stopSession();
    activeBackend = null;
    // Wait for process cleanup before starting new provider
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Create new backend
  activeProvider = newProvider;
  activeBackend = PROVIDERS[newProvider]();
  info("ai", "provider_switched", { provider: newProvider });
}

/**
 * Switch model, automatically switching provider if the model belongs to a different one.
 * Returns the provider name that was activated.
 */
export async function switchModel(model: ModelName): Promise<AIProviderName> {
  const targetProvider = getProviderForModel(model);
  if (!targetProvider) {
    throw new Error(`Unknown model: ${model}. Available: ${getAvailableModels().join(", ")}`);
  }

  const currentProvider = activeProvider || resolveProviderName();
  const needsProviderSwitch = currentProvider !== targetProvider;

  if (needsProviderSwitch) {
    // Full provider switch: terminate old, create new
    await switchProvider(targetProvider);
  }

  // Set the model on the (possibly new) backend
  await getBackend().setModel(model);
  return targetProvider;
}

// --- Delegated backend methods ---

export function getAIProviderName(): AIProviderName {
  return getBackend().providerName;
}

export async function runAI(
  message: string,
  onChunk?: (text: string) => Promise<void>
): Promise<AIResponse> {
  return getBackend().run(message, onChunk);
}

export function isSessionStuck(): boolean {
  return getBackend().isSessionStuck();
}

export function isSessionRestarting(): boolean {
  return getBackend().isSessionRestarting();
}

export function isSessionAlive(): boolean {
  return getBackend().isSessionAlive();
}

export async function restartSession(): Promise<void> {
  return getBackend().restartSession();
}

export function stopSession(): void {
  getBackend().stopSession();
}

export function getStats(): AIStats | null {
  return getBackend().getStats();
}

export async function setModel(model: ModelName): Promise<void> {
  return getBackend().setModel(model);
}

export function getCurrentModel(): ModelName {
  return getBackend().getCurrentModel();
}

export function hasProcessedMessages(): boolean {
  return getBackend().hasProcessedMessages();
}

export function getSessionId(): string {
  return getBackend().getSessionId();
}

export function getCircuitBreakerState(): string {
  return getBackend().getCircuitBreakerState();
}

export function resetCircuitBreaker(): void {
  getBackend().resetCircuitBreaker();
}

export type { AIBackend, AIProviderName, AIResponse, AIStats } from "./types";
