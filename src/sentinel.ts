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
import { runSelfHealingChecks, recordError as recordSelfHealError } from "./self-heal";

// --- Constants ---

const SENTINEL_DIR = join(homedir(), ".claude", "gateway");
const SENTINEL_MD_PATH = join(SENTINEL_DIR, "SENTINEL.md");
const HISTORY_PATH = join(SENTINEL_DIR, "sentinel-history.json");
const ACK_TOKEN = "SENTINEL_OK";
const MAX_HISTORY = 20;
const BEAT_TIMEOUT_MS = 90_000; // 90s max per beat
const RUNTIME_ALERT_PATTERN =
  /\b(gateway|runtime|session|process|pm2|memory|disk|cpu|network|telegram|timeout|crash|failed|error|stuck|unresponsive|down)\b/i;

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

function classifySentinelError(errorMessage: string): "timeout" | "process_crash" | "unknown" {
  const msg = errorMessage.toLowerCase();
  if (msg.includes("timeout") || msg.includes("timed out")) {
    return "timeout";
  }
  if (msg.includes("spawn") || msg.includes("exit") || msg.includes("crash") || msg.includes("econn")) {
    return "process_crash";
  }
  return "unknown";
}

function shouldAutoRecoverFromAlert(response: string): boolean {
  return RUNTIME_ALERT_PATTERN.test(response);
}

async function triggerSentinelAutoRecovery(trigger: string, details: string): Promise<void> {
  info("sentinel", "auto_recovery_start", { trigger, details: details.substring(0, 300) });
  try {
    await runSelfHealingChecks();
    info("sentinel", "auto_recovery_complete", { trigger });
  } catch (err) {
    logError("sentinel", "auto_recovery_failed", {
      trigger,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
  let autoRecoveryTrigger: string | null = null;
  let autoRecoveryDetails = "";

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
      const errText = result.error || "AI returned failure";
      recordSelfHealError(classifySentinelError(errText), `sentinel beat failed: ${errText}`);
      autoRecoveryTrigger = "sentinel_beat_failed";
      autoRecoveryDetails = errText;
      addHistory({
        timestamp: new Date().toISOString(),
        result: "error",
        message: errText,
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
      const runtimeIssueDetected = shouldAutoRecoverFromAlert(response);
      if (runtimeIssueDetected) {
        recordSelfHealError("unknown", `sentinel runtime alert: ${response.substring(0, 500)}`);
        autoRecoveryTrigger = "sentinel_runtime_alert";
        autoRecoveryDetails = response.substring(0, 500);
      }
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
          const recoveryLine = runtimeIssueDetected
            ? "\n\n<b>Auto-recovery:</b> Triggered self-heal checks."
            : "";
          await notifyUser(adminId, `${icon} <b>Sentinel Alert</b>\n\n${safeResponse}${recoveryLine}`).catch((err) => {
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
    const errText = err instanceof Error ? err.message : String(err);
    logError("sentinel", "beat_error", {
      error: errText,
    });
    recordSelfHealError(classifySentinelError(errText), `sentinel beat exception: ${errText}`);
    autoRecoveryTrigger = "sentinel_beat_exception";
    autoRecoveryDetails = errText;
    addHistory({
      timestamp: new Date().toISOString(),
      result: "error",
      message: errText,
      durationMs,
    });
  } finally {
    releaseAISlot();
    if (autoRecoveryTrigger) {
      await triggerSentinelAutoRecovery(autoRecoveryTrigger, autoRecoveryDetails);
    }
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
