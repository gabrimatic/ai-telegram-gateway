import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { env } from "./env";

export type ModelName = "haiku" | "opus" | "gpt-5.3-codex" | (string & {});

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeoutMs: number;
}

export interface AlertingConfig {
  enabled: boolean;
  throttleMinutes: number;
}

export type TTSVoice = "alloy" | "ash" | "ballad" | "coral" | "echo" | "fable" | "onyx" | "nova" | "sage" | "shimmer" | "verse" | "marin" | "cedar";

export interface ResourcesConfig {
  memoryWarningPercent: number;
  memoryCriticalPercent: number;
  diskWarningPercent: number;
  diskPath: string;
  maxFilesStorageMB: number;
}

export interface SecurityConfig {
  commandWarningsEnabled: boolean;
  argValidationMode: "moderate" | "strict";
}

export interface GatewayConfig {
  debug: boolean;
  aiProvider: string;
  providerDisplayName: string;
  dailyResetHour: number;
  sessionResetIntervalHours: number;
  memoryPath: string;
  logRetentionDays: number;
  healthCheckIntervalMs: number;
  sessionSummaryPrompt: string;
  mcpConfigPath: string;
  defaultModel: ModelName;
  // Resilience settings
  maxRetries: number;
  retryBaseDelayMs: number;
  validResponseRateThreshold: number;
  consecutiveFailureThreshold: number;
  enableSystemPrompt: boolean;
  confusionMarkers: string[];
  circuitBreaker: CircuitBreakerConfig;
  // TTS settings
  enableTTS: boolean;
  ttsVoice: TTSVoice;
  ttsSpeed: number;
  ttsInstructions: string;
  // Alerting settings
  alerting: AlertingConfig;
  // Resource monitoring settings
  resources: ResourcesConfig;
  // Command and validation behavior
  security: SecurityConfig;
}

const CONFIG_PATH = env.TG_GATEWAY_CONFIG;

const DEFAULT_CONFIG: GatewayConfig = {
  debug: false,
  aiProvider: "claude-cli",
  providerDisplayName: "Claude",
  dailyResetHour: 6,
  sessionResetIntervalHours: 4,
  memoryPath: env.TG_MEMORY_FILE,
  logRetentionDays: 7,
  healthCheckIntervalMs: 60000,
  sessionSummaryPrompt:
    "Summarize this session: key decisions, outcomes, what to remember for next time. Be concise.",
  mcpConfigPath: env.TG_MCP_CONFIG,
  defaultModel: "opus",
  // Resilience defaults
  maxRetries: 3,
  retryBaseDelayMs: 1000,
  validResponseRateThreshold: 0.7,
  consecutiveFailureThreshold: 3,
  enableSystemPrompt: true,
  confusionMarkers: [
    "I don't understand",
    "Could you clarify",
    "I'm not sure what you mean",
    "Can you rephrase",
    "I'm confused",
  ],
  circuitBreaker: {
    failureThreshold: 3,
    recoveryTimeoutMs: 30000,
  },
  // TTS defaults - OpenAI
  enableTTS: false,
  ttsVoice: "nova",
  ttsSpeed: 1.0,
  ttsInstructions: "Speak naturally and conversationally, like a friendly assistant. Use appropriate pauses and inflection. Be warm but not overly enthusiastic.",
  // Alerting defaults
  alerting: {
    enabled: true,
    throttleMinutes: 5,
  },
  // Resource monitoring defaults
  resources: {
    memoryWarningPercent: 80,
    memoryCriticalPercent: 90,
    diskWarningPercent: 90,
    diskPath: env.TG_DATA_DIR,
    maxFilesStorageMB: 500,
  },
  security: {
    commandWarningsEnabled: true,
    argValidationMode: "moderate",
  },
};

let currentConfig: GatewayConfig = { ...DEFAULT_CONFIG };

function expandPath(path: string): string {
  if (path.startsWith("~")) {
    return path.replace("~", env.TG_DATA_DIR.replace("/.claude", ""));
  }
  if (path.startsWith("./")) {
    return dirname(CONFIG_PATH) + "/../" + path.slice(2);
  }
  return path;
}

export function loadConfig(): GatewayConfig {
  if (!existsSync(CONFIG_PATH)) {
    // Create default config
    const configDir = dirname(CONFIG_PATH);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    currentConfig = { ...DEFAULT_CONFIG };
    return currentConfig;
  }

  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(content) as Partial<GatewayConfig>;

    // Merge with defaults
    currentConfig = {
      debug: parsed.debug ?? DEFAULT_CONFIG.debug,
      aiProvider: parsed.aiProvider ?? DEFAULT_CONFIG.aiProvider,
      providerDisplayName: parsed.providerDisplayName ?? DEFAULT_CONFIG.providerDisplayName,
      dailyResetHour: parsed.dailyResetHour ?? DEFAULT_CONFIG.dailyResetHour,
      sessionResetIntervalHours:
        parsed.sessionResetIntervalHours ?? DEFAULT_CONFIG.sessionResetIntervalHours,
      memoryPath: expandPath(parsed.memoryPath ?? DEFAULT_CONFIG.memoryPath),
      logRetentionDays: parsed.logRetentionDays ?? DEFAULT_CONFIG.logRetentionDays,
      healthCheckIntervalMs:
        parsed.healthCheckIntervalMs ?? DEFAULT_CONFIG.healthCheckIntervalMs,
      sessionSummaryPrompt:
        parsed.sessionSummaryPrompt ?? DEFAULT_CONFIG.sessionSummaryPrompt,
      mcpConfigPath: expandPath(parsed.mcpConfigPath ?? DEFAULT_CONFIG.mcpConfigPath),
      defaultModel: parsed.defaultModel ?? DEFAULT_CONFIG.defaultModel,
      // Resilience settings
      maxRetries: parsed.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      retryBaseDelayMs: parsed.retryBaseDelayMs ?? DEFAULT_CONFIG.retryBaseDelayMs,
      validResponseRateThreshold:
        parsed.validResponseRateThreshold ?? DEFAULT_CONFIG.validResponseRateThreshold,
      consecutiveFailureThreshold:
        parsed.consecutiveFailureThreshold ?? DEFAULT_CONFIG.consecutiveFailureThreshold,
      enableSystemPrompt: parsed.enableSystemPrompt ?? DEFAULT_CONFIG.enableSystemPrompt,
      confusionMarkers: parsed.confusionMarkers ?? DEFAULT_CONFIG.confusionMarkers,
      // TTS settings
      enableTTS: parsed.enableTTS ?? DEFAULT_CONFIG.enableTTS,
      ttsVoice: parsed.ttsVoice ?? DEFAULT_CONFIG.ttsVoice,
      ttsSpeed: parsed.ttsSpeed ?? DEFAULT_CONFIG.ttsSpeed,
      ttsInstructions: parsed.ttsInstructions ?? DEFAULT_CONFIG.ttsInstructions,
      // Circuit breaker settings
      circuitBreaker: {
        failureThreshold: parsed.circuitBreaker?.failureThreshold ?? DEFAULT_CONFIG.circuitBreaker.failureThreshold,
        recoveryTimeoutMs: parsed.circuitBreaker?.recoveryTimeoutMs ?? DEFAULT_CONFIG.circuitBreaker.recoveryTimeoutMs,
      },
      // Alerting settings
      alerting: {
        enabled: parsed.alerting?.enabled ?? DEFAULT_CONFIG.alerting.enabled,
        throttleMinutes: parsed.alerting?.throttleMinutes ?? DEFAULT_CONFIG.alerting.throttleMinutes,
      },
      // Resource monitoring settings
      resources: {
        memoryWarningPercent: parsed.resources?.memoryWarningPercent ?? DEFAULT_CONFIG.resources.memoryWarningPercent,
        memoryCriticalPercent: parsed.resources?.memoryCriticalPercent ?? DEFAULT_CONFIG.resources.memoryCriticalPercent,
        diskWarningPercent: parsed.resources?.diskWarningPercent ?? DEFAULT_CONFIG.resources.diskWarningPercent,
        diskPath: expandPath(parsed.resources?.diskPath ?? DEFAULT_CONFIG.resources.diskPath),
        maxFilesStorageMB: parsed.resources?.maxFilesStorageMB ?? DEFAULT_CONFIG.resources.maxFilesStorageMB,
      },
      security: {
        commandWarningsEnabled:
          parsed.security?.commandWarningsEnabled ?? DEFAULT_CONFIG.security.commandWarningsEnabled,
        argValidationMode:
          parsed.security?.argValidationMode === "strict" ? "strict" : DEFAULT_CONFIG.security.argValidationMode,
      },
    };

    return currentConfig;
  } catch (err) {
    console.error("[Config] Failed to load config, using defaults:", err);
    currentConfig = { ...DEFAULT_CONFIG };
    return currentConfig;
  }
}

export function getConfig(): GatewayConfig {
  return currentConfig;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
