/**
 * Sentinel - proactive turn mechanism.
 * Periodically wakes the main Claude session, reads SENTINEL.md,
 * and either silently acks or messages the user with findings.
 *
 * Key difference from task-scheduler: sentinel runs inside the live
 * session via runAI(), so it has full conversation context and memory.
 *
 * NOTE: Model override is intentionally not supported. setModel()
 * restarts the Claude session, which destroys conversation context -
 * the very thing sentinel exists to leverage. Beats always run on
 * whatever model the main session is using.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { runAI } from "./ai";
import { getConfig } from "./config";
import { info, warn, error as logError, debug } from "./logger";
import { tryAcquireAISlot, releaseAISlot } from "./poller";

// --- Constants ---

const SENTINEL_DIR = join(homedir(), ".claude", "gateway");
const SENTINEL_MD_PATH = join(SENTINEL_DIR, "SENTINEL.md");
const HISTORY_PATH = join(SENTINEL_DIR, "sentinel-history.json");
const ACK_TOKEN = "SENTINEL_OK";
const MAX_HISTORY = 20;
const BEAT_TIMEOUT_MS = 90_000; // 90s max per beat

// --- Types ---

export interface SentinelHistoryEntry {
  timestamp: string;
  result: "ack" | "alert" | "skipped" | "error";
  message?: string;
  durationMs?: number;
}

// --- State ---

let sentinelInterval: NodeJS.Timeout | null = null;
let beatInProgress = false;
let history: SentinelHistoryEntry[] = [];
let notifyUser: ((userId: string, message: string) => Promise<void>) | null = null;
let lastBeatTime: Date | null = null;
let enabled = false;

// --- Helpers ---

function ensureDir(): void {
  if (!existsSync(SENTINEL_DIR)) {
    mkdirSync(SENTINEL_DIR, { recursive: true });
  }
}

function isWithinActiveHours(): boolean {
  const config = getConfig();
  const hb = config.sentinel;
  if (!hb) return true;

  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: hb.timezone,
  });
  const currentHour = parseInt(formatter.format(now), 10);

  // Handle overnight wraparound (e.g. start=22, end=6)
  if (hb.activeHoursStart <= hb.activeHoursEnd) {
    return currentHour >= hb.activeHoursStart && currentHour < hb.activeHoursEnd;
  } else {
    return currentHour >= hb.activeHoursStart || currentHour < hb.activeHoursEnd;
  }
}

function loadSentinelMd(): string | null {
  if (!existsSync(SENTINEL_MD_PATH)) return null;
  try {
    const content = readFileSync(SENTINEL_MD_PATH, "utf-8");
    // Skip if file is empty, whitespace-only, or just headers
    const stripped = content.replace(/^#.*$/gm, "").trim();
    if (stripped.length === 0) return null;
    return content;
  } catch {
    return null;
  }
}

function isAckResponse(response: string): boolean {
  const trimmed = response.trim();
  const config = getConfig();
  const maxChars = config.sentinel?.ackMaxChars ?? 300;

  // Must start with the ack token
  if (!trimmed.startsWith(ACK_TOKEN)) return false;

  // If total length is within ackMaxChars, treat as ack
  // This allows responses like "SENTINEL_OK - all systems nominal"
  return trimmed.length <= maxChars;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildSentinelPrompt(checklistContent: string): string {
  const now = new Date().toISOString();
  return [
    `[SENTINEL] This is a scheduled system health check, NOT a user message.`,
    `You may use session context if relevant to the checks below.`,
    `Read the checklist below and execute each item independently.`,
    `If all checks pass, return only this token: ${ACK_TOKEN}`,
    `Only include findings that represent actual problems right now.`,
    `Current time: ${now}`,
    ``,
    `--- SENTINEL.md ---`,
    checklistContent,
    `--- END ---`,
  ].join("\n");
}

function loadHistory(): SentinelHistoryEntry[] {
  try {
    if (existsSync(HISTORY_PATH)) {
      const data = readFileSync(HISTORY_PATH, "utf-8");
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed.slice(-MAX_HISTORY);
    }
  } catch {
    // Corrupted file, start fresh
  }
  return [];
}

function saveHistory(): void {
  try {
    ensureDir();
    writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  } catch {
    // Non-critical, log and continue
  }
}

function addHistory(entry: SentinelHistoryEntry): void {
  history.push(entry);
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }
  saveHistory();
}

/** Run a promise with a timeout. Rejects with Error on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// --- Core beat ---

async function runBeat(): Promise<void> {
  if (beatInProgress) {
    debug("sentinel", "skipped_in_progress");
    addHistory({ timestamp: new Date().toISOString(), result: "skipped", message: "beat already in progress" });
    return;
  }

  if (!isWithinActiveHours()) {
    debug("sentinel", "skipped_outside_hours");
    addHistory({ timestamp: new Date().toISOString(), result: "skipped", message: "outside active hours" });
    return;
  }

  const checklist = loadSentinelMd();
  if (!checklist) {
    debug("sentinel", "skipped_no_checklist");
    addHistory({ timestamp: new Date().toISOString(), result: "skipped", message: "no SENTINEL.md or empty" });
    return;
  }

  // Atomic check-and-acquire: prevents race between isAIBusy check and slot acquisition
  if (!tryAcquireAISlot()) {
    debug("sentinel", "skipped_ai_busy");
    addHistory({ timestamp: new Date().toISOString(), result: "skipped", message: "AI is busy processing user messages" });
    return;
  }

  beatInProgress = true;
  const startTime = Date.now();

  try {
    const prompt = buildSentinelPrompt(checklist);
    info("sentinel", "beat_starting");

    const result = await withTimeout(runAI(prompt), BEAT_TIMEOUT_MS, "sentinel beat");
    const durationMs = Date.now() - startTime;
    lastBeatTime = new Date();

    if (!result.success) {
      logError("sentinel", "beat_failed", { error: result.error });
      addHistory({
        timestamp: new Date().toISOString(),
        result: "error",
        message: result.error || "AI returned failure",
        durationMs,
      });
      return;
    }

    const response = result.response.trim();

    if (isAckResponse(response)) {
      info("sentinel", "beat_ack", { durationMs });
      addHistory({
        timestamp: new Date().toISOString(),
        result: "ack",
        durationMs,
      });
    } else {
      info("sentinel", "beat_alert", { durationMs, responseLength: response.length });
      addHistory({
        timestamp: new Date().toISOString(),
        result: "alert",
        message: response.substring(0, 500),
        durationMs,
      });

      // Send alert to admin
      if (notifyUser) {
        const adminId = process.env.TG_ADMIN_ID;
        if (adminId) {
          const icon = "\u{1F493}";
          const safeResponse = escapeHtml(response);
          await notifyUser(adminId, `${icon} <b>Sentinel Alert</b>\n\n${safeResponse}`).catch((err) => {
            logError("sentinel", "notify_failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } else {
          warn("sentinel", "no_admin_id_for_notification");
        }
      }
    }
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logError("sentinel", "beat_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    addHistory({
      timestamp: new Date().toISOString(),
      result: "error",
      message: err instanceof Error ? err.message : String(err),
      durationMs,
    });
  } finally {
    releaseAISlot();
    beatInProgress = false;
  }
}

// --- Public API ---

export function initSentinel(
  notifier: (userId: string, message: string) => Promise<void>
): void {
  ensureDir();
  notifyUser = notifier;

  // Restore persisted history from disk
  history = loadHistory();

  const config = getConfig();
  if (!config.sentinel?.enabled) {
    info("sentinel", "disabled_by_config");
    return;
  }

  startSentinel();
}

export function startSentinel(): void {
  if (sentinelInterval) {
    warn("sentinel", "already_running");
    return;
  }

  const config = getConfig();
  const intervalMs = (config.sentinel?.intervalMinutes ?? 30) * 60 * 1000;
  enabled = true;

  sentinelInterval = setInterval(() => {
    runBeat().catch((err) => {
      logError("sentinel", "interval_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  // Don't block process exit
  sentinelInterval.unref();

  // Run first beat after a short delay instead of waiting a full interval
  const firstBeatTimer = setTimeout(() => {
    runBeat().catch((err) => {
      logError("sentinel", "first_beat_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, 5000);
  firstBeatTimer.unref();

  info("sentinel", "started", {
    intervalMinutes: config.sentinel?.intervalMinutes ?? 30,
    activeHours: `${config.sentinel?.activeHoursStart ?? 8}-${config.sentinel?.activeHoursEnd ?? 23}`,
    timezone: config.sentinel?.timezone ?? "Europe/Berlin",
  });
}

export function stopSentinel(): void {
  if (sentinelInterval) {
    clearInterval(sentinelInterval);
    sentinelInterval = null;
  }
  enabled = false;
  info("sentinel", "stopped");
}

export function isSentinelRunning(): boolean {
  return sentinelInterval !== null && enabled;
}

export function triggerBeat(): Promise<void> {
  return runBeat();
}

export function getSentinelStatus(): {
  enabled: boolean;
  running: boolean;
  lastBeatTime: Date | null;
  beatInProgress: boolean;
  history: SentinelHistoryEntry[];
  checklistExists: boolean;
} {
  return {
    enabled,
    running: sentinelInterval !== null,
    lastBeatTime,
    beatInProgress,
    history: [...history],
    checklistExists: existsSync(SENTINEL_MD_PATH),
  };
}

export function getSentinelHistory(): SentinelHistoryEntry[] {
  return [...history];
}

export function getSentinelMdPath(): string {
  return SENTINEL_MD_PATH;
}

export function getSentinelMdContent(): string | null {
  return loadSentinelMd();
}

export function writeSentinelMd(content: string): void {
  ensureDir();
  writeFileSync(SENTINEL_MD_PATH, content, "utf-8");
}

const DEFAULT_SENTINEL_MD = `# Sentinel Checklist

## System Health
- Check disk usage on /. Alert if above 90%.
- Check memory pressure. Alert if consistently above 95%.
- Check if any PM2 processes are erroring or stopped.

## Network
- Verify internet connectivity with a quick DNS lookup.

## Services
- Confirm the Telegram gateway is responsive (you're running this, so it is).
`;

export function createDefaultSentinelMd(): boolean {
  if (existsSync(SENTINEL_MD_PATH)) return false;
  ensureDir();
  writeFileSync(SENTINEL_MD_PATH, DEFAULT_SENTINEL_MD, "utf-8");
  return true;
}
