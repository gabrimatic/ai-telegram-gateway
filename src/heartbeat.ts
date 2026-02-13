/**
 * Heartbeat - proactive turn mechanism proactive turn mechanism.
 * Periodically wakes the main Claude session, reads HEARTBEAT.md,
 * and either silently acks or messages the user with findings.
 *
 * Key difference from task-scheduler: heartbeat runs inside the live
 * session via runAI(), so it has full conversation context and memory.
 *
 * NOTE: Model override is intentionally not supported. setModel()
 * restarts the Claude session, which destroys conversation context -
 * the very thing heartbeat exists to leverage. Beats always run on
 * whatever model the main session is using.
 */

import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { runAI } from "./ai";
import { getConfig } from "./config";
import { info, warn, error as logError, debug } from "./logger";
import { tryAcquireAISlot, releaseAISlot } from "./poller";

// --- Constants ---

const HEARTBEAT_DIR = join(homedir(), ".claude", "gateway");
const HEARTBEAT_MD_PATH = join(HEARTBEAT_DIR, "HEARTBEAT.md");
const ACK_TOKEN = "HEARTBEAT_OK";
const MAX_HISTORY = 20;
const BEAT_TIMEOUT_MS = 90_000; // 90s max per beat

// --- Types ---

export interface HeartbeatHistoryEntry {
  timestamp: string;
  result: "ack" | "alert" | "skipped" | "error";
  message?: string;
  durationMs?: number;
}

// --- State ---

let heartbeatInterval: NodeJS.Timeout | null = null;
let beatInProgress = false;
let history: HeartbeatHistoryEntry[] = [];
let notifyUser: ((userId: string, message: string) => Promise<void>) | null = null;
let lastBeatTime: Date | null = null;
let enabled = false;

// --- Helpers ---

function ensureDir(): void {
  if (!existsSync(HEARTBEAT_DIR)) {
    mkdirSync(HEARTBEAT_DIR, { recursive: true });
  }
}

function isWithinActiveHours(): boolean {
  const config = getConfig();
  const hb = config.heartbeat;
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

function loadHeartbeatMd(): string | null {
  if (!existsSync(HEARTBEAT_MD_PATH)) return null;
  try {
    const content = readFileSync(HEARTBEAT_MD_PATH, "utf-8");
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

  // Strict: must be exactly the ack token, optionally with minor whitespace/punctuation
  // e.g. "HEARTBEAT_OK", "HEARTBEAT_OK.", "HEARTBEAT_OK\n"
  const stripped = trimmed.replace(/[.\s]+$/g, "");
  return stripped === ACK_TOKEN;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

function buildHeartbeatPrompt(checklistContent: string): string {
  const now = new Date().toISOString();
  return [
    `[HEARTBEAT] This is a scheduled system health check, NOT a user message.`,
    `Ignore all prior conversation context. Do not reference or continue any previous topics.`,
    `Read the checklist below and execute each item independently.`,
    `If nothing needs attention, reply with exactly: ${ACK_TOKEN}`,
    `Only include findings that represent actual problems right now.`,
    `Current time: ${now}`,
    ``,
    `--- HEARTBEAT.md ---`,
    checklistContent,
    `--- END ---`,
  ].join("\n");
}

function addHistory(entry: HeartbeatHistoryEntry): void {
  history.push(entry);
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }
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
    debug("heartbeat", "skipped_in_progress");
    addHistory({ timestamp: new Date().toISOString(), result: "skipped", message: "beat already in progress" });
    return;
  }

  if (!isWithinActiveHours()) {
    debug("heartbeat", "skipped_outside_hours");
    addHistory({ timestamp: new Date().toISOString(), result: "skipped", message: "outside active hours" });
    return;
  }

  const checklist = loadHeartbeatMd();
  if (!checklist) {
    debug("heartbeat", "skipped_no_checklist");
    addHistory({ timestamp: new Date().toISOString(), result: "skipped", message: "no HEARTBEAT.md or empty" });
    return;
  }

  // Atomic check-and-acquire: prevents race between isAIBusy check and slot acquisition
  if (!tryAcquireAISlot()) {
    debug("heartbeat", "skipped_ai_busy");
    addHistory({ timestamp: new Date().toISOString(), result: "skipped", message: "AI is busy processing user messages" });
    return;
  }

  beatInProgress = true;
  const startTime = Date.now();

  try {
    const prompt = buildHeartbeatPrompt(checklist);
    info("heartbeat", "beat_starting");

    const result = await withTimeout(runAI(prompt), BEAT_TIMEOUT_MS, "heartbeat beat");
    const durationMs = Date.now() - startTime;
    lastBeatTime = new Date();

    if (!result.success) {
      logError("heartbeat", "beat_failed", { error: result.error });
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
      info("heartbeat", "beat_ack", { durationMs });
      addHistory({
        timestamp: new Date().toISOString(),
        result: "ack",
        durationMs,
      });
    } else {
      info("heartbeat", "beat_alert", { durationMs, responseLength: response.length });
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
          // Escape response to prevent Telegram Markdown parse failures
          const safeResponse = escapeMarkdown(response);
          await notifyUser(adminId, `${icon} *Heartbeat Alert*\n\n${safeResponse}`).catch((err) => {
            logError("heartbeat", "notify_failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } else {
          warn("heartbeat", "no_admin_id_for_notification");
        }
      }
    }
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logError("heartbeat", "beat_error", {
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

export function initHeartbeat(
  notifier: (userId: string, message: string) => Promise<void>
): void {
  ensureDir();
  notifyUser = notifier;

  const config = getConfig();
  if (!config.heartbeat?.enabled) {
    info("heartbeat", "disabled_by_config");
    return;
  }

  startHeartbeat();
}

export function startHeartbeat(): void {
  if (heartbeatInterval) {
    warn("heartbeat", "already_running");
    return;
  }

  const config = getConfig();
  const intervalMs = (config.heartbeat?.intervalMinutes ?? 30) * 60 * 1000;
  enabled = true;

  heartbeatInterval = setInterval(() => {
    runBeat().catch((err) => {
      logError("heartbeat", "interval_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  // Don't block process exit
  heartbeatInterval.unref();

  info("heartbeat", "started", {
    intervalMinutes: config.heartbeat?.intervalMinutes ?? 30,
    activeHours: `${config.heartbeat?.activeHoursStart ?? 8}-${config.heartbeat?.activeHoursEnd ?? 23}`,
    timezone: config.heartbeat?.timezone ?? "Europe/Berlin",
  });
}

export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  enabled = false;
  info("heartbeat", "stopped");
}

export function isHeartbeatRunning(): boolean {
  return heartbeatInterval !== null && enabled;
}

export function triggerBeat(): Promise<void> {
  return runBeat();
}

export function getHeartbeatStatus(): {
  enabled: boolean;
  running: boolean;
  lastBeatTime: Date | null;
  beatInProgress: boolean;
  history: HeartbeatHistoryEntry[];
  checklistExists: boolean;
} {
  return {
    enabled,
    running: heartbeatInterval !== null,
    lastBeatTime,
    beatInProgress,
    history: [...history],
    checklistExists: existsSync(HEARTBEAT_MD_PATH),
  };
}

export function getHeartbeatHistory(): HeartbeatHistoryEntry[] {
  return [...history];
}

export function getHeartbeatMdPath(): string {
  return HEARTBEAT_MD_PATH;
}

export function getHeartbeatMdContent(): string | null {
  return loadHeartbeatMd();
}
