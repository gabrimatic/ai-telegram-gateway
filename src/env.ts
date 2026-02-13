/**
 * Environment configuration with sensible defaults
 * All paths can be overridden via environment variables
 */
import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

const HOME = homedir();

// Determine project directory (works whether running from src/ or dist/)
const PROJECT_DIR = join(__dirname, "..");

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

export const env = {
  // Core directories
  TG_DATA_DIR: process.env.TG_DATA_DIR || join(HOME, ".claude"),
  TG_LOG_DIR: process.env.TG_LOG_DIR || join(HOME, ".claude", "logs", "telegram-gateway"),
  TG_HEALTH_FILE: process.env.TG_HEALTH_FILE || join(HOME, ".claude", "gateway", "health.json"),
  TG_PROJECT_DIR: process.env.TG_PROJECT_DIR || PROJECT_DIR,
  TG_PROJECT_PATH_HINT: process.env.TG_PROJECT_PATH_HINT || "",
  TG_PM2_APP_NAME: process.env.TG_PM2_APP_NAME || "telegram-gateway",
  TG_HOST_LABEL: process.env.TG_HOST_LABEL || "local host",
  TG_ADMIN_NAME: process.env.TG_ADMIN_NAME || "",
  TG_BOT_USERNAME: process.env.TG_BOT_USERNAME || "",
  TG_ENABLE_DANGEROUS_COMMANDS: parseBoolean(process.env.TG_ENABLE_DANGEROUS_COMMANDS, true),

  // Claude CLI
  CLAUDE_BIN: process.env.CLAUDE_BIN || join(HOME, ".local", "bin", "claude"),

  // Codex CLI
  CODEX_BIN: process.env.CODEX_BIN || "/opt/homebrew/bin/codex",

  // Files
  TG_MEMORY_FILE: process.env.TG_MEMORY_FILE || join(HOME, ".claude", "memory.md"),
  TG_ALLOWLIST_FILE: process.env.TG_ALLOWLIST_FILE || join(HOME, ".claude", "telegram-allowlist.json"),
  TG_PID_FILE: process.env.TG_PID_FILE || join(PROJECT_DIR, "gateway.pid"),
  TG_MCP_CONFIG: process.env.TG_MCP_CONFIG || join(PROJECT_DIR, "mcp-config.json"),
  TG_GATEWAY_CONFIG: process.env.TG_GATEWAY_CONFIG || join(PROJECT_DIR, "config", "gateway.json"),

  // Working directory for Claude CLI (sandboxed to prevent junk in $HOME)
  TG_WORKING_DIR: process.env.TG_WORKING_DIR || join(HOME, ".claude", "gateway", "sandbox"),

  // Service hosts/ports
  WHISPERKIT_HOST: process.env.WHISPERKIT_HOST || "localhost",
  WHISPERKIT_PORT: parseInt(process.env.WHISPERKIT_PORT || "50060", 10),
};

// Ensure sandbox directory exists at module load time
try {
  mkdirSync(env.TG_WORKING_DIR, { recursive: true });
} catch {
  // Best-effort; will fail later if truly broken
}

// Derived URLs for convenience
export const WHISPERKIT_BASE_URL = `http://${env.WHISPERKIT_HOST}:${env.WHISPERKIT_PORT}`;
