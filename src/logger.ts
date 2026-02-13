import { existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { env } from "./env";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  event: string;
  requestId?: string;
  data?: Record<string, unknown>;
}

interface LoggerConfig {
  debug: boolean;
  logRetentionDays: number;
}

const LOG_DIR = env.TG_LOG_DIR;
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let config: LoggerConfig = {
  debug: false,
  logRetentionDays: 7,
};

let logDirEnsured = false;
let logCleanupInterval: NodeJS.Timeout | null = null;

// Write buffer to reduce disk I/O - flush periodically or when buffer is large
const writeBuffers: Map<string, string[]> = new Map();
const FLUSH_INTERVAL_MS = 2000;
const MAX_BUFFER_LINES = 50;
let flushInterval: NodeJS.Timeout | null = null;

function getOrCreateBuffer(path: string): string[] {
  let buf = writeBuffers.get(path);
  if (!buf) {
    buf = [];
    writeBuffers.set(path, buf);
  }
  return buf;
}

function flushAllBuffers(): void {
  for (const [path, lines] of writeBuffers.entries()) {
    if (lines.length === 0) continue;
    try {
      ensureLogDir();
      appendFileSync(path, lines.join("\n") + "\n");
    } catch {
      // Silently ignore write errors during flush
    }
    lines.length = 0;
  }
}

function startFlushTimer(): void {
  if (flushInterval) return;
  flushInterval = setInterval(flushAllBuffers, FLUSH_INTERVAL_MS);
  flushInterval.unref();
}

function stopFlushTimer(): void {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
  // Final flush
  flushAllBuffers();
}

function ensureLogDir(): void {
  if (logDirEnsured) return;
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  logDirEnsured = true;
}

function getDateString(): string {
  return new Date().toISOString().split("T")[0];
}

function getLogPath(type: "gateway" | "error" | "debug"): string {
  return join(LOG_DIR, `${type}.${getDateString()}.log`);
}

function formatEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}

function writeToFile(path: string, entry: LogEntry): void {
  const buf = getOrCreateBuffer(path);
  buf.push(formatEntry(entry));
  // Flush immediately if buffer is large (prevents memory buildup during bursts)
  if (buf.length >= MAX_BUFFER_LINES) {
    try {
      ensureLogDir();
      appendFileSync(path, buf.join("\n") + "\n");
      buf.length = 0;
    } catch {
      // Silently ignore write errors
    }
  }
}

function cleanOldLogs(): void {
  if (!existsSync(LOG_DIR)) return;

  const now = Date.now();
  const maxAge = config.logRetentionDays * 24 * 60 * 60 * 1000;

  try {
    const files = readdirSync(LOG_DIR);
    for (const file of files) {
      const filePath = join(LOG_DIR, file);
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > maxAge) {
        unlinkSync(filePath);
      }
    }
  } catch (err) {
    // Silently ignore cleanup errors
  }
}

export function initLogger(loggerConfig: LoggerConfig): void {
  config = loggerConfig;
  ensureLogDir();
  cleanOldLogs();
  startFlushTimer();
}

export function startLogMaintenance(): void {
  if (logCleanupInterval) {
    return;
  }
  cleanOldLogs();
  logCleanupInterval = setInterval(cleanOldLogs, LOG_CLEANUP_INTERVAL_MS);
}

export function stopLogMaintenance(): void {
  if (!logCleanupInterval) {
    return;
  }
  clearInterval(logCleanupInterval);
  logCleanupInterval = null;
  stopFlushTimer();
}

export function log(
  level: LogLevel,
  component: string,
  event: string,
  data?: Record<string, unknown>,
  requestId?: string
): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    component,
    event,
    ...(requestId && { requestId }),
    ...(data && { data }),
  };

  // Always write to gateway log
  writeToFile(getLogPath("gateway"), entry);

  // Write errors to error log
  if (level === "error") {
    writeToFile(getLogPath("error"), entry);
  }

  // Write debug only if debug mode is enabled
  if (level === "debug" && config.debug) {
    writeToFile(getLogPath("debug"), entry);
  }

  // Also output to console for daemon visibility
  const reqPrefix = requestId ? ` [${requestId}]` : "";
  const consoleMsg = `[${entry.ts}] [${level.toUpperCase()}] [${component}]${reqPrefix} ${event}`;
  if (data && Object.keys(data).length > 0) {
    console.log(consoleMsg, JSON.stringify(data));
  } else {
    console.log(consoleMsg);
  }
}

export function debug(component: string, event: string, data?: Record<string, unknown>, requestId?: string): void {
  if (config.debug) {
    log("debug", component, event, data, requestId);
  }
}

export function info(component: string, event: string, data?: Record<string, unknown>, requestId?: string): void {
  log("info", component, event, data, requestId);
}

export function warn(component: string, event: string, data?: Record<string, unknown>, requestId?: string): void {
  log("warn", component, event, data, requestId);
}

export function error(component: string, event: string, data?: Record<string, unknown>, requestId?: string): void {
  log("error", component, event, data, requestId);
}

export function getLogDir(): string {
  return LOG_DIR;
}
