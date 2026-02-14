/**
 * Task Scheduler - schedule one-time or recurring tasks that spawn Claude CLI instances.
 * Persists schedules to ~/.claude/gateway/schedules.json.
 * Uses node-cron for cron-based scheduling.
 */

import { spawn, exec, execFile } from "child_process";
import * as readline from "readline";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  appendFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, extname } from "path";
import { homedir } from "os";
import * as cron from "node-cron";
import { env } from "./env";
import { getConfig } from "./config";
import { info, warn, error as logError, debug } from "./logger";
import { isAdminUser, loadAllowlist } from "./storage";
import { executeTelegramApiCall, parseTelegramApiPayload, parseTelegramApiTags, removeTelegramApiTags, TelegramApiContextLike } from "./telegram-api-executor";
import { buildStaticSystemPrompt } from "./system-prompt";
import { isDegradedMode, getDegradedReason, enterDegradedMode } from "./ai/auth-check";
import { isAuthFailureText } from "./ai/auth-failure";

// --- Types ---

export interface ScheduleHistoryEntry {
  timestamp: string;
  result: string;
  duration: number; // ms
  success: boolean;
}

export interface Schedule {
  id: number;
  type: "once" | "cron";
  jobType: "prompt" | "shell" | "script";
  cronExpression?: string;
  scheduledTime?: string; // ISO string for one-time
  task: string; // prompt text, shell command, or script path
  output: "telegram" | "silent" | string; // "file:/path" or "email:addr"
  name?: string; // human-readable name
  status: "active" | "completed" | "cancelled" | "failed";
  createdAt: string;
  lastRun?: string;
  nextRun?: string;
  runLeaseToken?: string;
  runLeaseStartedAt?: string;
  runLeaseHeartbeatAt?: string;
  lastFailureKind?: ScheduleFailureKind;
  lastAttemptCount?: number;
  userId: string;
  history: ScheduleHistoryEntry[];
}

export interface ScheduleStore {
  schedules: Schedule[];
  nextId: number;
}

// --- Constants ---

const SCHEDULES_DIR = join(homedir(), ".claude", "gateway");
const SCHEDULES_PATH = join(SCHEDULES_DIR, "schedules.json");
const SCHEDULES_LOCK_PATH = join(SCHEDULES_DIR, "schedules.lock");
const MAX_HISTORY_PER_SCHEDULE = 50;
const TASK_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes per task execution
const MAX_SET_TIMEOUT_MS = 2_147_483_647; // Node.js max setTimeout delay (~24.8 days)
const STORE_LOCK_TIMEOUT_MS = 5_000;
const STORE_LOCK_RETRY_MS = 25;
const STORE_LOCK_STALE_MS = 30_000;
const TIMEZONE = "Europe/Berlin";
const RANDOM_CHECKIN_MASTER_TASK = "__tg_random_checkin_master__";
const RANDOM_CHECKIN_MESSAGE_PREFIX = "__tg_random_checkin_message__";
const RANDOM_CHECKIN_DAILY_CRON = "5 0 * * *";
const RANDOM_CHECKIN_MAX_MESSAGES_PER_DAY = 10;
const RANDOM_CHECKIN_MIN_GAP_MINUTES = 60;
const RANDOM_CHECKIN_DAY_START_MINUTES = 8 * 60;
const RANDOM_CHECKIN_DAY_END_MINUTES = 23 * 60; // 23:00 exclusive
const RANDOM_CHECKIN_MIN_LEAD_MINUTES = 5;
const RANDOM_CHECKIN_MAX_TELEGRAM_CHARS = 220;
const RANDOM_CHECKIN_FALLBACK_MESSAGE = "Quick check-in: take one small step on your top priority now.";
const MAX_STDERR_CAPTURE_BYTES = 4096;
const FAST_FAIL_RETRY_WINDOW_MS = 2000;
const AUTH_UNAVAILABLE_ERROR = "AI backend authentication required. Please ask the admin to re-authenticate the CLI.";
const LEASE_STALE_GRACE_MS = 15_000;
const LEASE_STALE_MS = TASK_TIMEOUT_MS + LEASE_STALE_GRACE_MS;
const SCHEDULER_RECONCILE_INTERVAL_MS = 60_000;

// --- State ---

// Active cron jobs keyed by schedule ID
const activeCronJobs: Map<number, cron.ScheduledTask> = new Map();
// Active one-time timers keyed by schedule ID
const activeTimers: Map<number, NodeJS.Timeout> = new Map();
// Running tasks keyed by schedule ID (prevents overlap on long cron jobs/reloads)
const runningSchedules: Set<number> = new Set();
let runtimeReconcilerTimer: NodeJS.Timeout | null = null;
// Notification callback - set by the bot integration
let notifyUser: ((userId: string, message: string) => Promise<void>) | null = null;
let telegramApiContextProvider: (() => TelegramApiContextLike & { botId?: number }) | null = null;

interface SchedulerReconcileStats {
  cycleStartedAt?: string;
  activeSchedules: number;
  repairedCronJobs: number;
  repairedTimers: number;
  removedOrphanCronJobs: number;
  removedOrphanTimers: number;
  staleLeasesRecovered: number;
  overdueTriggered: number;
}

let lastReconcileStats: SchedulerReconcileStats = {
  activeSchedules: 0,
  repairedCronJobs: 0,
  repairedTimers: 0,
  removedOrphanCronJobs: 0,
  removedOrphanTimers: 0,
  staleLeasesRecovered: 0,
  overdueTriggered: 0,
};

export type ScheduleFailureKind =
  | "none"
  | "degraded"
  | "auth"
  | "result_error"
  | "process_exit"
  | "timeout"
  | "spawn_error"
  | "shell_error"
  | "script_error"
  | "delivery_failed"
  | "lease_active"
  | "cancelled"
  | "exception";

interface TaskExecutionResult {
  success: boolean;
  output: string;
  jobType: "prompt" | "shell" | "script";
  failureKind: ScheduleFailureKind;
  attempts: number;
  attemptDurationMs: number;
  hasModelOutput?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

// --- Storage ---

function ensureStorageDir(): void {
  if (!existsSync(SCHEDULES_DIR)) {
    mkdirSync(SCHEDULES_DIR, { recursive: true });
  }
}

function atomicWriteSync(filePath: string, content: string): void {
  const tempPath = join(dirname(filePath), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tempPath, content);
  renameSync(tempPath, filePath);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withStoreLock<T>(operation: () => T): T {
  ensureStorageDir();
  const startedAt = Date.now();
  let staleLockWarned = false;

  while (true) {
    try {
      const fd = openSync(SCHEDULES_LOCK_PATH, "wx");
      try {
        return operation();
      } finally {
        closeSync(fd);
        try {
          unlinkSync(SCHEDULES_LOCK_PATH);
        } catch {
          // Ignore cleanup errors.
        }
      }
    } catch (err) {
      const fsErr = err as NodeJS.ErrnoException;
      if (fsErr.code !== "EEXIST") {
        throw err;
      }

      try {
        const lockStat = statSync(SCHEDULES_LOCK_PATH);
        if (Date.now() - lockStat.mtimeMs > STORE_LOCK_STALE_MS) {
          unlinkSync(SCHEDULES_LOCK_PATH);
          if (!staleLockWarned) {
            warn("task-scheduler", "stale_store_lock_removed", {
              ageMs: Date.now() - lockStat.mtimeMs,
            });
            staleLockWarned = true;
          }
          continue;
        }
      } catch {
        // Lock disappeared between checks, retry.
      }

      if (Date.now() - startedAt >= STORE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring schedule store lock after ${STORE_LOCK_TIMEOUT_MS}ms`);
      }

      sleepMs(STORE_LOCK_RETRY_MS);
    }
  }
}

function normalizeSchedule(raw: unknown): Schedule | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Schedule>;
  const id = Number(value.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (value.type !== "once" && value.type !== "cron") return null;
  if (typeof value.task !== "string" || value.task.trim().length === 0) return null;
  if (typeof value.userId !== "string" || value.userId.trim().length === 0) return null;

  const jobType = value.jobType === "shell" || value.jobType === "script" || value.jobType === "prompt"
    ? value.jobType
    : "prompt";
  const status = value.status === "active" || value.status === "completed" || value.status === "cancelled" || value.status === "failed"
    ? value.status
    : "active";
  const output = typeof value.output === "string" && value.output.trim().length > 0
    ? value.output
    : "telegram";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString();
  const history = Array.isArray(value.history)
    ? value.history.filter((entry): entry is ScheduleHistoryEntry => {
        if (!entry || typeof entry !== "object") return false;
        const candidate = entry as Partial<ScheduleHistoryEntry>;
        return (
          typeof candidate.timestamp === "string"
          && typeof candidate.result === "string"
          && typeof candidate.duration === "number"
          && typeof candidate.success === "boolean"
        );
      })
    : [];

  const schedule: Schedule = {
    id,
    type: value.type,
    jobType,
    task: value.task,
    output,
    status,
    createdAt,
    userId: value.userId,
    history,
  };

  if (typeof value.name === "string" && value.name.trim().length > 0) {
    schedule.name = value.name;
  }
  if (typeof value.lastRun === "string") {
    schedule.lastRun = value.lastRun;
  }
  if (typeof value.nextRun === "string") {
    schedule.nextRun = value.nextRun;
  }
  if (typeof value.runLeaseToken === "string" && value.runLeaseToken.trim().length > 0) {
    schedule.runLeaseToken = value.runLeaseToken;
  }
  if (typeof value.runLeaseStartedAt === "string") {
    schedule.runLeaseStartedAt = value.runLeaseStartedAt;
  }
  if (typeof value.runLeaseHeartbeatAt === "string") {
    schedule.runLeaseHeartbeatAt = value.runLeaseHeartbeatAt;
  }
  if (typeof value.lastFailureKind === "string") {
    schedule.lastFailureKind = value.lastFailureKind as ScheduleFailureKind;
  }
  if (typeof value.lastAttemptCount === "number" && Number.isFinite(value.lastAttemptCount)) {
    schedule.lastAttemptCount = Math.max(0, Math.floor(value.lastAttemptCount));
  }
  if (value.type === "cron" && typeof value.cronExpression === "string") {
    schedule.cronExpression = value.cronExpression;
  }
  if (value.type === "once" && typeof value.scheduledTime === "string") {
    schedule.scheduledTime = value.scheduledTime;
  }

  return schedule;
}

function capHistory(history: ScheduleHistoryEntry[]): ScheduleHistoryEntry[] {
  return history.length > MAX_HISTORY_PER_SCHEDULE
    ? history.slice(-MAX_HISTORY_PER_SCHEDULE)
    : history;
}

function pushScheduleHistoryEntry(schedule: Schedule, entry: ScheduleHistoryEntry): void {
  schedule.history.push(entry);
  schedule.history = capHistory(schedule.history);
}

function clearScheduleLease(schedule: Schedule): void {
  schedule.runLeaseToken = undefined;
  schedule.runLeaseStartedAt = undefined;
  schedule.runLeaseHeartbeatAt = undefined;
}

function getLeaseTimestampMs(schedule: Schedule): number | null {
  const candidate = schedule.runLeaseHeartbeatAt ?? schedule.runLeaseStartedAt;
  if (!candidate) return null;
  const ts = new Date(candidate).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function isLeaseStale(schedule: Schedule, nowMs: number = Date.now()): boolean {
  if (!schedule.runLeaseToken) return false;
  const leaseTs = getLeaseTimestampMs(schedule);
  if (leaseTs === null) return true;
  return nowMs - leaseTs > LEASE_STALE_MS;
}

function updateScheduleNextRun(schedule: Schedule): void {
  if (schedule.type !== "cron" || schedule.status !== "active") return;
  const cronJob = activeCronJobs.get(schedule.id);
  if (!cronJob) return;
  try {
    const nextRun = cronJob.getNextRun();
    schedule.nextRun = nextRun ? nextRun.toISOString() : undefined;
  } catch {
    // getNextRun can throw for invalid/removed schedules.
  }
}

function loadSchedulesUnsafe(): ScheduleStore {
  ensureStorageDir();
  if (!existsSync(SCHEDULES_PATH)) {
    return { schedules: [], nextId: 1 };
  }
  try {
    const parsed = JSON.parse(readFileSync(SCHEDULES_PATH, "utf-8")) as Partial<ScheduleStore>;
    const schedules = Array.isArray(parsed.schedules)
      ? parsed.schedules.map((schedule) => normalizeSchedule(schedule)).filter((schedule): schedule is Schedule => schedule !== null)
      : [];
    const maxId = schedules.reduce((currentMax, schedule) => Math.max(currentMax, schedule.id), 0);
    const nextId = Number.isInteger(parsed.nextId) && (parsed.nextId as number) > maxId
      ? parsed.nextId as number
      : maxId + 1;
    return { schedules, nextId };
  } catch (err) {
    logError("task-scheduler", "load_schedules_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { schedules: [], nextId: 1 };
  }
}

function saveSchedulesUnsafe(store: ScheduleStore): void {
  ensureStorageDir();
  atomicWriteSync(SCHEDULES_PATH, JSON.stringify(store, null, 2));
}

function mutateSchedules<T>(mutator: (store: ScheduleStore) => T): T {
  return withStoreLock(() => {
    const store = loadSchedulesUnsafe();
    const result = mutator(store);
    saveSchedulesUnsafe(store);
    return result;
  });
}

export function loadSchedules(): ScheduleStore {
  return loadSchedulesUnsafe();
}

export function saveSchedules(store: ScheduleStore): void {
  withStoreLock(() => saveSchedulesUnsafe(store));
}

export interface CreateScheduleInput {
  type: "once" | "cron";
  jobType?: "prompt" | "shell" | "script";
  cronExpression?: string;
  scheduledTime?: string;
  task: string;
  output?: "telegram" | "silent" | string;
  name?: string;
  userId: string;
  status?: "active" | "completed" | "cancelled" | "failed";
  lastRun?: string;
  nextRun?: string;
}

export function createSchedule(input: CreateScheduleInput): Schedule {
  return mutateSchedules((store) => {
    const schedule: Schedule = {
      id: store.nextId++,
      type: input.type,
      jobType: input.jobType ?? "prompt",
      task: input.task,
      output: input.output ?? "telegram",
      status: input.status ?? "active",
      createdAt: new Date().toISOString(),
      userId: input.userId,
      history: [],
    };

    if (input.name && input.name.trim().length > 0) {
      schedule.name = input.name;
    }
    if (input.type === "cron" && input.cronExpression) {
      schedule.cronExpression = input.cronExpression;
    }
    if (input.type === "once" && input.scheduledTime) {
      schedule.scheduledTime = input.scheduledTime;
      schedule.nextRun = input.nextRun ?? input.scheduledTime;
    } else if (input.nextRun) {
      schedule.nextRun = input.nextRun;
    }
    if (input.lastRun) {
      schedule.lastRun = input.lastRun;
    }

    store.schedules.push(schedule);
    return schedule;
  });
}

export interface RandomCheckinStatus {
  enabled: boolean;
  masterId?: number;
  activeMessageCount: number;
}

export interface RandomCheckinEnableResult {
  createdMaster: boolean;
  masterId: number;
  generatedToday: number;
  dateKey: string;
  skippedReason?: string;
}

export interface RandomCheckinDisableResult {
  cancelledMasters: number;
  cancelledMessages: number;
}

export interface RandomCheckinRegenerateResult {
  generated: number;
  dateKey: string;
  skippedReason?: string;
}

interface BerlinDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface RandomCheckinTaskPayload {
  dateKey: string;
  slot: number;
  prompt: string;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function getBerlinDateParts(date: Date = new Date()): BerlinDateParts {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const getPart = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number(value) : 0;
  };
  return {
    year: getPart("year"),
    month: getPart("month"),
    day: getPart("day"),
    hour: getPart("hour"),
    minute: getPart("minute"),
    second: getPart("second"),
  };
}

function toBerlinDateKey(parts: BerlinDateParts): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function getTimezoneOffsetMinutes(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const getPart = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number(value) : 0;
  };
  const reconstructedUtcMs = Date.UTC(
    getPart("year"),
    getPart("month") - 1,
    getPart("day"),
    getPart("hour"),
    getPart("minute"),
    getPart("second")
  );
  return Math.round((reconstructedUtcMs - date.getTime()) / 60000);
}

function berlinLocalDateToIso(parts: BerlinDateParts, minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const utcGuessMs = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0);

  const firstOffset = getTimezoneOffsetMinutes(new Date(utcGuessMs), TIMEZONE);
  let timestamp = utcGuessMs - firstOffset * 60_000;

  const secondOffset = getTimezoneOffsetMinutes(new Date(timestamp), TIMEZONE);
  if (secondOffset !== firstOffset) {
    timestamp = utcGuessMs - secondOffset * 60_000;
  }

  return new Date(timestamp).toISOString();
}

function randomIntInclusive(min: number, max: number): number {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getMaxSlotCount(startMinute: number, endMinuteExclusive: number, minGapMinutes: number): number {
  const span = endMinuteExclusive - startMinute;
  if (span <= 0) return 0;
  return 1 + Math.floor((span - 1) / minGapMinutes);
}

function generateRandomMinutes(
  startMinute: number,
  endMinuteExclusive: number,
  count: number,
  minGapMinutes: number
): number[] {
  const slots: number[] = [];
  let cursor = startMinute;

  for (let index = 0; index < count; index++) {
    const remaining = count - index - 1;
    const latestMinute = endMinuteExclusive - (remaining * minGapMinutes) - 1;
    if (latestMinute < cursor) break;

    const picked = randomIntInclusive(cursor, latestMinute);
    slots.push(picked);
    cursor = picked + minGapMinutes;
  }

  return slots;
}

function berlinMinuteOfDayFromIso(iso?: string): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = getBerlinDateParts(date);
  return (parts.hour * 60) + parts.minute;
}

function buildRandomCheckinPrompt(slot: number, total: number): string {
  return [
    `Send one short check-in message (${slot}/${total}) for the user.`,
    "",
    "Hard rules:",
    "- Keep it friendly and useful.",
    "- Maximum 30 words.",
    "- Return plain text only (single message, no markdown).",
    "- Use only facts you can verify from tools/context available right now.",
    "- Prefer context like calendar, fresh email updates via gog, web data, Berlin local time, weather, and upcoming events when available.",
    "- If external data is unavailable, give a practical short nudge based on Berlin time of day.",
  ].join("\n");
}

function buildRandomCheckinTask(dateKey: string, slot: number, prompt: string): string {
  return `${RANDOM_CHECKIN_MESSAGE_PREFIX}|${dateKey}|${slot}|${prompt}`;
}

function parseRandomCheckinTask(task: string): RandomCheckinTaskPayload | null {
  if (!task.startsWith(`${RANDOM_CHECKIN_MESSAGE_PREFIX}|`)) {
    return null;
  }
  const parts = task.split("|");
  if (parts.length < 4) {
    return null;
  }
  const slot = Number(parts[2]);
  if (!Number.isInteger(slot) || slot <= 0) {
    return null;
  }
  return {
    dateKey: parts[1],
    slot,
    prompt: parts.slice(3).join("|"),
  };
}

function isRandomCheckinMasterTask(task: string): boolean {
  return task.trim() === RANDOM_CHECKIN_MASTER_TASK;
}

function isRandomCheckinMessageTask(task: string): boolean {
  return parseRandomCheckinTask(task) !== null;
}

function getTaskPromptForExecution(task: string): string {
  const payload = parseRandomCheckinTask(task);
  if (!payload) return task;
  return payload.prompt;
}

function buildRandomCheckinDisplayName(slot: number, total: number): string {
  return `Random check-in ${slot}/${total}`;
}

function scheduleRuntime(schedule: Schedule): void {
  if (schedule.status !== "active") return;
  if (schedule.type === "cron") {
    scheduleCronTask(schedule);
  } else if (schedule.type === "once") {
    scheduleOnceTask(schedule);
  }
}

interface InternalRandomCheckinGenerationResult {
  createdSchedules: Schedule[];
  generated: number;
  dateKey: string;
  skippedReason?: string;
}

function generateRandomCheckinsForDate(
  userId: string,
  dateParts: BerlinDateParts,
  startMinute: number
): InternalRandomCheckinGenerationResult {
  const dateKey = toBerlinDateKey(dateParts);
  const nowMs = Date.now();

  const mutationResult = mutateSchedules((store) => {
    let completedCount = 0;
    let lastCompletedMinute: number | null = null;

    for (const existing of store.schedules) {
      if (existing.userId !== userId) continue;
      const payload = parseRandomCheckinTask(existing.task);
      if (!payload || payload.dateKey !== dateKey) continue;

      if (existing.status === "completed") {
        completedCount++;
        const minute = berlinMinuteOfDayFromIso(existing.scheduledTime ?? existing.lastRun);
        if (minute !== null) {
          lastCompletedMinute = lastCompletedMinute === null
            ? minute
            : Math.max(lastCompletedMinute, minute);
        }
      }

      if (existing.status === "active") {
        stopScheduleRuntime(existing.id);
        existing.status = "cancelled";
        existing.nextRun = undefined;
      }
    }

    const remainingQuota = Math.max(RANDOM_CHECKIN_MAX_MESSAGES_PER_DAY - completedCount, 0);
    if (remainingQuota <= 0) {
      return {
        createdSchedules: [] as Schedule[],
        skippedReason: `Daily limit already reached (${completedCount}/${RANDOM_CHECKIN_MAX_MESSAGES_PER_DAY}).`,
      };
    }

    let effectiveStart = Math.max(startMinute, RANDOM_CHECKIN_DAY_START_MINUTES);
    if (lastCompletedMinute !== null) {
      effectiveStart = Math.max(
        effectiveStart,
        lastCompletedMinute + RANDOM_CHECKIN_MIN_GAP_MINUTES
      );
    }

    const maxAllowedByWindow = getMaxSlotCount(
      effectiveStart,
      RANDOM_CHECKIN_DAY_END_MINUTES,
      RANDOM_CHECKIN_MIN_GAP_MINUTES
    );
    const maxCount = Math.min(maxAllowedByWindow, remainingQuota);

    if (maxCount <= 0) {
      return {
        createdSchedules: [] as Schedule[],
        skippedReason: "No valid times left today that satisfy spacing and cutoff rules.",
      };
    }

    const minCount = Math.min(4, maxCount);
    const targetCount = randomIntInclusive(minCount, maxCount);
    const minuteSlots = generateRandomMinutes(
      effectiveStart,
      RANDOM_CHECKIN_DAY_END_MINUTES,
      targetCount,
      RANDOM_CHECKIN_MIN_GAP_MINUTES
    );

    if (minuteSlots.length === 0) {
      return {
        createdSchedules: [] as Schedule[],
        skippedReason: "Could not generate valid random slots.",
      };
    }

    const schedulesToCreate = minuteSlots
      .map((minute, index) => {
        const scheduledTime = berlinLocalDateToIso(dateParts, minute);
        if (new Date(scheduledTime).getTime() <= nowMs) {
          return null;
        }
        return {
          scheduledTime,
          slot: index + 1,
        };
      })
      .filter((entry): entry is { scheduledTime: string; slot: number } => entry !== null);

    if (schedulesToCreate.length === 0) {
      return {
        createdSchedules: [] as Schedule[],
        skippedReason: "Generated times are already in the past.",
      };
    }

    const generated: Schedule[] = [];
    for (const entry of schedulesToCreate) {
      const schedule: Schedule = {
        id: store.nextId++,
        type: "once",
        jobType: "prompt",
        task: buildRandomCheckinTask(
          dateKey,
          entry.slot,
          buildRandomCheckinPrompt(entry.slot, schedulesToCreate.length)
        ),
        output: "telegram",
        status: "active",
        createdAt: new Date().toISOString(),
        userId,
        history: [],
        name: buildRandomCheckinDisplayName(entry.slot, schedulesToCreate.length),
        scheduledTime: entry.scheduledTime,
        nextRun: entry.scheduledTime,
      };
      store.schedules.push(schedule);
      generated.push(schedule);
    }

    return { createdSchedules: generated as Schedule[] };
  });

  const createdSchedules = mutationResult.createdSchedules;

  for (const schedule of createdSchedules) {
    scheduleRuntime(schedule);
  }

  return {
    createdSchedules,
    generated: createdSchedules.length,
    dateKey,
    skippedReason: mutationResult.skippedReason,
  };
}

function ensureRandomCheckinMaster(userId: string): { master: Schedule; created: boolean } {
  const result = mutateSchedules((store) => {
    const activeMasters = store.schedules
      .filter((schedule) => schedule.userId === userId
        && schedule.status === "active"
        && isRandomCheckinMasterTask(schedule.task))
      .sort((a, b) => a.id - b.id);

    if (activeMasters.length > 0) {
      const [primary, ...duplicates] = activeMasters;
      for (const duplicate of duplicates) {
        stopScheduleRuntime(duplicate.id);
        duplicate.status = "cancelled";
        duplicate.nextRun = undefined;
      }
      return { master: primary, created: false };
    }

    const created: Schedule = {
      id: store.nextId++,
      type: "cron",
      jobType: "prompt",
      task: RANDOM_CHECKIN_MASTER_TASK,
      output: "silent",
      status: "active",
      createdAt: new Date().toISOString(),
      userId,
      history: [],
      name: "Random check-ins daily planner",
      cronExpression: RANDOM_CHECKIN_DAILY_CRON,
    };
    store.schedules.push(created);
    return { master: created, created: true };
  });

  scheduleRuntime(result.master);
  return result;
}

export function isRandomCheckinMasterSchedule(schedule: Schedule): boolean {
  return isRandomCheckinMasterTask(schedule.task);
}

export function isRandomCheckinMessageSchedule(schedule: Schedule): boolean {
  return isRandomCheckinMessageTask(schedule.task);
}

export function getRandomCheckinStatus(userId: string): RandomCheckinStatus {
  const store = loadSchedules();
  const activeSchedules = store.schedules.filter((schedule) => schedule.userId === userId && schedule.status === "active");
  const master = activeSchedules.find((schedule) => isRandomCheckinMasterTask(schedule.task));
  const activeMessageCount = activeSchedules.filter((schedule) => isRandomCheckinMessageTask(schedule.task)).length;
  return {
    enabled: Boolean(master),
    masterId: master?.id,
    activeMessageCount,
  };
}

export function regenerateRandomCheckinsForToday(userId: string): RandomCheckinRegenerateResult {
  const berlinNow = getBerlinDateParts();
  const startMinute = (berlinNow.hour * 60) + berlinNow.minute + RANDOM_CHECKIN_MIN_LEAD_MINUTES;
  const result = generateRandomCheckinsForDate(userId, berlinNow, startMinute);
  info("task-scheduler", "random_checkins_regenerated", {
    userId,
    date: result.dateKey,
    generated: result.generated,
    reason: result.skippedReason,
  });
  return {
    generated: result.generated,
    dateKey: result.dateKey,
    skippedReason: result.skippedReason,
  };
}

function reconcileRandomCheckinsForToday(): void {
  const store = loadSchedules();
  const berlinNow = getBerlinDateParts();
  const dateKey = toBerlinDateKey(berlinNow);
  const startMinute = (berlinNow.hour * 60) + berlinNow.minute + RANDOM_CHECKIN_MIN_LEAD_MINUTES;
  const userIds = new Set<string>();

  for (const schedule of store.schedules) {
    if (schedule.status !== "active") continue;
    if (!isRandomCheckinMasterTask(schedule.task)) continue;
    userIds.add(schedule.userId);
  }

  for (const userId of userIds) {
    const hasAnyTodayMessage = store.schedules.some((schedule) => {
      if (schedule.userId !== userId) return false;
      const payload = parseRandomCheckinTask(schedule.task);
      return Boolean(payload && payload.dateKey === dateKey);
    });
    if (hasAnyTodayMessage) continue;

    const result = generateRandomCheckinsForDate(userId, berlinNow, startMinute);
    info("task-scheduler", "random_checkins_startup_reconciled", {
      userId,
      dateKey,
      generated: result.generated,
      reason: result.skippedReason,
    });
  }
}

export function enableRandomCheckins(userId: string): RandomCheckinEnableResult {
  const { master, created } = ensureRandomCheckinMaster(userId);
  const regenerated = regenerateRandomCheckinsForToday(userId);
  return {
    createdMaster: created,
    masterId: master.id,
    generatedToday: regenerated.generated,
    dateKey: regenerated.dateKey,
    skippedReason: regenerated.skippedReason,
  };
}

export function disableRandomCheckins(userId: string): RandomCheckinDisableResult {
  const idsToStop: number[] = [];
  const result = mutateSchedules((store) => {
    let cancelledMasters = 0;
    let cancelledMessages = 0;
    for (const schedule of store.schedules) {
      if (schedule.userId !== userId || schedule.status !== "active") continue;
      if (isRandomCheckinMasterTask(schedule.task)) {
        schedule.status = "cancelled";
        schedule.nextRun = undefined;
        idsToStop.push(schedule.id);
        cancelledMasters++;
        continue;
      }
      if (isRandomCheckinMessageTask(schedule.task)) {
        schedule.status = "cancelled";
        schedule.nextRun = undefined;
        idsToStop.push(schedule.id);
        cancelledMessages++;
      }
    }
    return { cancelledMasters, cancelledMessages };
  });

  for (const scheduleId of idsToStop) {
    stopScheduleRuntime(scheduleId);
  }

  info("task-scheduler", "random_checkins_disabled", {
    userId,
    cancelledMasters: result.cancelledMasters,
    cancelledMessages: result.cancelledMessages,
  });
  return result;
}

// --- Claude CLI execution ---

interface StreamMessage {
  type: string;
  subtype?: string;
  is_error?: boolean;
  error?: string;
  content?: string;
  message?: {
    content?: Array<{ type: string; text?: string }> | string;
  };
  result?: string;
}

/**
 * Spawn a fresh Claude CLI process, send the task, collect output.
 * Returns the response text.
 */
async function executeClaudeTask(task: string): Promise<TaskExecutionResult> {
  const startTime = Date.now();
  if (isDegradedMode()) {
    const reason = getDegradedReason();
    const message = reason
      ? `AI backend authentication is unavailable (degraded mode): ${reason}`
      : "AI backend authentication is unavailable (degraded mode).";
    return {
      output: message,
      success: false,
      jobType: "prompt",
      attemptDurationMs: Date.now() - startTime,
      attempts: 1,
      hasModelOutput: false,
      failureKind: "degraded",
      exitCode: null,
      signal: null,
    };
  }

  const config = getConfig();
  const claudePath = env.CLAUDE_BIN;

  return new Promise((resolve) => {
    let output = "";
    let stderrBuffer = "";
    let resolved = false;
    let timeoutHit = false;
    let sawResult = false;
    let sawSuccessfulResult = false;
    let resultIsError = false;
    let hasModelOutput = false;

    const appendStderr = (chunk: string) => {
      if (!chunk) return;
      const combined = stderrBuffer + chunk;
      if (combined.length <= MAX_STDERR_CAPTURE_BYTES) {
        stderrBuffer = combined;
      } else {
        stderrBuffer = combined.slice(combined.length - MAX_STDERR_CAPTURE_BYTES);
      }
    };

    const finish = (result: TaskExecutionResult) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const schedulerSystemPrompt = buildStaticSystemPrompt({
      providerDisplayName: config.providerDisplayName,
    });

    const filteredEnv = { ...process.env };
    delete filteredEnv.CLAUDECODE;
    delete filteredEnv.CLAUDE_CODE_ENTRYPOINT;
    delete filteredEnv.INIT_CWD;
    delete filteredEnv.PWD;
    delete filteredEnv.OLDPWD;

    const proc = spawn(
      claudePath,
      [
        "--print",
        "--verbose",
        "--dangerously-skip-permissions",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        config.defaultModel,
        "--mcp-config",
        config.mcpConfigPath,
        "--tools",
        "Bash,Read,WebSearch,WebFetch",
        "--setting-sources",
        "",
        "--system-prompt",
        schedulerSystemPrompt,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: env.TG_WORKING_DIR,
        env: filteredEnv,
      }
    );

    const rl = readline.createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      try {
        const msg: StreamMessage = JSON.parse(line);

        // Collect assistant content
        if (msg.type === "assistant" && msg.message?.content) {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                output += block.text;
                hasModelOutput = true;
              }
            }
          } else if (typeof content === "string") {
            output += content;
            hasModelOutput = true;
          }
        }

        // Content deltas
        if (msg.type === "content_block_delta" && msg.content) {
          output += msg.content;
          hasModelOutput = true;
        }

        // Result marks completion metadata for this response.
        if (msg.type === "result") {
          sawResult = true;
          if (msg.is_error === true || msg.subtype === "error") {
            resultIsError = true;
          }
          if (msg.result) {
            output = msg.result;
            hasModelOutput = true;
          }
          if (msg.error && !output.trim()) {
            output = msg.error;
          }
          if (!resultIsError) {
            sawSuccessfulResult = true;
          }
        } else if (msg.type === "error") {
          resultIsError = true;
          if (msg.error && !output.trim()) {
            output = msg.error;
          }
        }
      } catch {
        // Not JSON, ignore
      }
    });

    proc.stderr?.on("data", (data) => {
      appendStderr(data.toString());
    });

    proc.on("close", (code, signal) => {
      rl.close();
      const attemptDurationMs = Date.now() - startTime;
      const stderrSnippet = stderrBuffer.trim();
      const trimmedOutput = output.trim();

      info("task-scheduler", "claude_task_closed", {
        exitCode: code,
        signal: signal ?? null,
        sawResult,
        resultIsError,
        stderrSnippet: stderrSnippet ? stderrSnippet.slice(0, 500) : undefined,
      });

      if (isAuthFailureText(trimmedOutput)) {
        enterDegradedMode("Scheduler prompt detected backend auth failure");
        finish({
          output: AUTH_UNAVAILABLE_ERROR,
          success: false,
          jobType: "prompt",
          attemptDurationMs,
          attempts: 1,
          hasModelOutput,
          failureKind: "auth",
          exitCode: code ?? null,
          signal: signal ?? null,
        });
        return;
      }

      const success = !timeoutHit
        && !resultIsError
        && (sawSuccessfulResult || (code === 0 && !sawResult && hasModelOutput));

      if (!success) {
        const failureOutput = trimmedOutput
          || stderrSnippet
          || `Process exited (code ${code ?? "null"}, signal ${signal ?? "none"})`;
        finish({
          output: failureOutput,
          success: false,
          jobType: "prompt",
          attemptDurationMs,
          attempts: 1,
          hasModelOutput,
          failureKind: timeoutHit
            ? "timeout"
            : resultIsError
              ? "result_error"
              : "process_exit",
          exitCode: code ?? null,
          signal: signal ?? null,
        });
        return;
      }

      finish({
        output: trimmedOutput || "(no output)",
        success: true,
        jobType: "prompt",
        attemptDurationMs,
        attempts: 1,
        hasModelOutput,
        failureKind: "none",
        exitCode: code ?? null,
        signal: signal ?? null,
      });
    });

    proc.on("error", (err) => {
      logError("task-scheduler", "claude_spawn_error", { error: err.message });
      finish({
        output: err.message || "Failed to spawn Claude CLI process.",
        success: false,
        jobType: "prompt",
        attemptDurationMs: Date.now() - startTime,
        attempts: 1,
        hasModelOutput,
        failureKind: "spawn_error",
        exitCode: null,
        signal: null,
      });
    });

    // Timeout
    const timeout = setTimeout(() => {
      timeoutHit = true;
      logError("task-scheduler", "task_timeout", { task });
      proc.kill("SIGKILL");
      if (!output.trim()) {
        output = "Task timed out while waiting for Claude response.";
      }
    }, TASK_TIMEOUT_MS);

    proc.on("close", () => clearTimeout(timeout));

    // Send the task
    const inputMessage = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: task,
      },
    });

    proc.stdin!.write(inputMessage + "\n", (err) => {
      if (err) {
        logError("task-scheduler", "stdin_write_error", { error: err.message });
        finish({
          output: err.message || "Failed to write task input to Claude CLI.",
          success: false,
          jobType: "prompt",
          attemptDurationMs: Date.now() - startTime,
          attempts: 1,
          hasModelOutput,
          failureKind: "spawn_error",
          exitCode: null,
          signal: null,
        });
        return;
      }
      // Close stdin so Claude knows no more input is coming for this single-turn
      proc.stdin!.end();
    });
  });
}

function shouldRetryPromptTask(result: TaskExecutionResult): boolean {
  if (result.success) return false;
  if (result.failureKind === "degraded" || result.failureKind === "auth" || result.failureKind === "result_error") {
    return false;
  }
  return result.attemptDurationMs < FAST_FAIL_RETRY_WINDOW_MS && !result.hasModelOutput;
}

// --- Shell / Script execution ---

/**
 * Execute a shell command with timeout.
 */
async function executeShellTask(command: string): Promise<TaskExecutionResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    exec(command, { timeout: TASK_TIMEOUT_MS, cwd: env.TG_WORKING_DIR }, (err, stdout, stderr) => {
      const combined = (stdout + "\n" + stderr).trim();
      const duration = Date.now() - start;
      if (err) {
        const execErr = err as NodeJS.ErrnoException & { code?: number | string; signal?: NodeJS.Signals };
        resolve({
          output: combined || err.message || "Shell command failed.",
          success: false,
          jobType: "shell",
          failureKind: execErr.signal === "SIGTERM" || execErr.signal === "SIGKILL" ? "timeout" : "shell_error",
          attempts: 1,
          attemptDurationMs: duration,
          exitCode: typeof execErr.code === "number" ? execErr.code : null,
          signal: execErr.signal ?? null,
        });
      } else {
        resolve({
          output: combined || "(no output)",
          success: true,
          jobType: "shell",
          failureKind: "none",
          attempts: 1,
          attemptDurationMs: duration,
          exitCode: 0,
          signal: null,
        });
      }
    });
  });
}

/**
 * Execute a script file with the appropriate interpreter.
 */
async function executeScriptTask(scriptPath: string): Promise<TaskExecutionResult> {
  const ext = extname(scriptPath).toLowerCase();
  let command: string;
  switch (ext) {
    case ".sh":
      command = `bash "${scriptPath}"`;
      break;
    case ".py":
      command = `python3 "${scriptPath}"`;
      break;
    case ".js":
      command = `node "${scriptPath}"`;
      break;
    case ".ts":
      command = `npx ts-node "${scriptPath}"`;
      break;
    default:
      return {
        output: `Unsupported script extension: ${ext}`,
        success: false,
        jobType: "script",
        failureKind: "script_error",
        attempts: 1,
        attemptDurationMs: 0,
        exitCode: null,
        signal: null,
      };
  }
  const shellResult = await executeShellTask(command);
  return {
    ...shellResult,
    jobType: "script",
    failureKind: shellResult.success ? "none" : (shellResult.failureKind === "timeout" ? "timeout" : "script_error"),
  };
}

async function executeRandomCheckinPlannerTask(userId: string): Promise<TaskExecutionResult> {
  const start = Date.now();
  const regenerated = regenerateRandomCheckinsForToday(userId);
  if (regenerated.generated > 0) {
    return {
      output: `Generated ${regenerated.generated} random check-ins for ${regenerated.dateKey}.`,
      success: true,
      jobType: "prompt",
      failureKind: "none",
      attempts: 1,
      attemptDurationMs: Date.now() - start,
      exitCode: 0,
      signal: null,
    };
  }
  return {
    output: regenerated.skippedReason
      ? `Skipped random check-in generation for ${regenerated.dateKey}: ${regenerated.skippedReason}`
      : `No random check-ins generated for ${regenerated.dateKey}.`,
    success: true,
    jobType: "prompt",
    failureKind: "none",
    attempts: 1,
    attemptDurationMs: Date.now() - start,
    exitCode: 0,
    signal: null,
  };
}

interface RunLeaseClaimResult {
  claimed: boolean;
  reason?: "not_found" | "inactive" | "lease_active";
  schedule?: Schedule;
  existingLeaseToken?: string;
}

function recoverStaleLeases(nowMs: number = Date.now()): number {
  return withStoreLock(() => {
    const store = loadSchedulesUnsafe();
    let recovered = 0;
    for (const schedule of store.schedules) {
      if (!schedule.runLeaseToken) continue;
      if (!isLeaseStale(schedule, nowMs)) continue;

      const leaseStarted = schedule.runLeaseStartedAt ?? "unknown";
      const entry: ScheduleHistoryEntry = {
        timestamp: new Date().toISOString(),
        result: `Recovered stale run lease from ${leaseStarted}. Previous run was marked failed for timeout/restart safety.`,
        duration: 0,
        success: false,
      };
      pushScheduleHistoryEntry(schedule, entry);
      schedule.lastRun = entry.timestamp;
      schedule.lastFailureKind = "timeout";
      schedule.lastAttemptCount = 1;
      if (schedule.type === "once" && schedule.status === "active") {
        schedule.status = "failed";
        schedule.nextRun = undefined;
      }
      clearScheduleLease(schedule);
      recovered++;
    }
    if (recovered > 0) {
      saveSchedulesUnsafe(store);
    }
    return recovered;
  });
}

function claimRunLease(scheduleId: number): RunLeaseClaimResult {
  return mutateSchedules((store) => {
    const schedule = store.schedules.find((s) => s.id === scheduleId);
    if (!schedule) return { claimed: false, reason: "not_found" };
    if (schedule.status !== "active") return { claimed: false, reason: "inactive" };

    const now = new Date().toISOString();
    if (schedule.runLeaseToken && !isLeaseStale(schedule)) {
      return {
        claimed: false,
        reason: "lease_active",
        existingLeaseToken: schedule.runLeaseToken,
      };
    }
    if (schedule.runLeaseToken && isLeaseStale(schedule)) {
      const staleEntry: ScheduleHistoryEntry = {
        timestamp: now,
        result: "Recovered stale run lease during claim. Previous run marked failed.",
        duration: 0,
        success: false,
      };
      pushScheduleHistoryEntry(schedule, staleEntry);
      schedule.lastRun = staleEntry.timestamp;
      schedule.lastFailureKind = "timeout";
      schedule.lastAttemptCount = 1;
      clearScheduleLease(schedule);
    }

    const token = `${schedule.id}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    schedule.runLeaseToken = token;
    schedule.runLeaseStartedAt = now;
    schedule.runLeaseHeartbeatAt = now;
    return {
      claimed: true,
      schedule: { ...schedule },
    };
  });
}

function finalizeRunLease(
  scheduleId: number,
  leaseToken: string,
  result: TaskExecutionResult,
  historyResultText: string,
  durationMs: number
): void {
  mutateSchedules((store) => {
    const stored = store.schedules.find((s) => s.id === scheduleId);
    if (!stored) return;
    if (stored.runLeaseToken !== leaseToken) {
      warn("task-scheduler", "lease_token_mismatch_on_finalize", {
        id: scheduleId,
        expected: leaseToken,
        actual: stored.runLeaseToken,
      });
      return;
    }

    const entry: ScheduleHistoryEntry = {
      timestamp: new Date().toISOString(),
      result: historyResultText.substring(0, 2000),
      duration: durationMs,
      success: result.success,
    };
    pushScheduleHistoryEntry(stored, entry);
    stored.lastRun = entry.timestamp;
    stored.lastFailureKind = result.failureKind;
    stored.lastAttemptCount = result.attempts;

    if (stored.type === "once") {
      if (stored.status === "active") {
        stored.status = result.success ? "completed" : "failed";
      }
      stored.nextRun = undefined;
    } else if (stored.status === "active") {
      updateScheduleNextRun(stored);
    }

    clearScheduleLease(stored);
  });
}

// --- Output routing ---

async function executePromptTelegramApiTags(schedule: Schedule, output: string): Promise<string> {
  const tagLimit = 20;
  const tags = parseTelegramApiTags(output);
  if (tags.length === 0) {
    return output;
  }

  const cleanedText = removeTelegramApiTags(output);
  const allowlist = await loadAllowlist();
  const isAdmin = isAdminUser(schedule.userId, allowlist);
  if (!isAdmin) {
    warn("task-scheduler", "telegram_api_tags_blocked_non_admin", {
      id: schedule.id,
      userId: schedule.userId,
      tagCount: tags.length,
    });
    return cleanedText.trim() || "Ignored Telegram API action tags (admin only).";
  }

  const context = telegramApiContextProvider?.();
  if (!context) {
    warn("task-scheduler", "telegram_api_context_unavailable", {
      id: schedule.id,
      tagCount: tags.length,
    });
    return cleanedText.trim() || "Telegram API actions skipped: bot API context unavailable.";
  }

  const summaryLines: string[] = [];
  const executable = tags.slice(0, tagLimit);
  for (let i = 0; i < executable.length; i++) {
    const tag = executable[i];
    const parsedPayload = parseTelegramApiPayload(tag.payload);
    if (!parsedPayload.ok || !parsedPayload.payload) {
      summaryLines.push(`#${i + 1} ${tag.method}: ERROR ${parsedPayload.error}`);
      continue;
    }

    const result = await executeTelegramApiCall(context, {
      method: tag.method,
      payload: parsedPayload.payload,
    }, {
      callerType: "scheduler",
      userId: schedule.userId,
      isAdmin: true,
      botId: context.botId,
    });

    if (result.success) {
      summaryLines.push(`#${i + 1} ${tag.method}: OK`);
    } else {
      const details = result.errorCode
        ? `${result.errorCode} ${result.description ?? ""}`.trim()
        : result.description ?? "failed";
      summaryLines.push(`#${i + 1} ${tag.method}: ERROR ${details}`);
    }
  }

  if (tags.length > tagLimit) {
    summaryLines.push(`Ignored ${tags.length - tagLimit} extra tag(s); max ${tagLimit} per response.`);
  }

  if (summaryLines.length > 0) {
    info("task-scheduler", "telegram_api_actions_executed", {
      id: schedule.id,
      userId: schedule.userId,
      summary: summaryLines.join(" | "),
    });
  }

  // Keep user-facing output to model text only.
  return cleanedText.trim();
}

/**
 * Route task output based on schedule.output setting.
 */
async function routeOutput(
  schedule: Schedule,
  taskOutput: string,
  success: boolean,
  durationMs: number
): Promise<string[]> {
  const deliveryWarnings: string[] = [];
  let effectiveTaskOutput = taskOutput;
  if ((schedule.jobType ?? "prompt") === "prompt") {
    try {
      effectiveTaskOutput = await executePromptTelegramApiTags(schedule, taskOutput);
    } catch (err) {
      const warningMsg = `Prompt action tags failed: ${err instanceof Error ? err.message : String(err)}`;
      deliveryWarnings.push(warningMsg);
      logError("task-scheduler", "task_output_delivery_failed", {
        id: schedule.id,
        channel: "telegram_api_tags",
        error: warningMsg,
      });
      effectiveTaskOutput = taskOutput;
    }
  }

  const outputTarget = schedule.output ?? "telegram";
  const statusIcon = success ? "\u2705" : "\u274C";
  const truncatedOutput = effectiveTaskOutput.length > 1500
    ? effectiveTaskOutput.substring(0, 1500) + "... (truncated)"
    : effectiveTaskOutput;
  const displayName = schedule.name ? ` (${schedule.name})` : "";
  const message = `${statusIcon} Task #${schedule.id}${displayName} ${success ? "completed" : "failed"} (${(durationMs / 1000).toFixed(1)}s):\n\n${truncatedOutput}`;

  if (outputTarget === "telegram") {
    if (notifyUser) {
      if (isRandomCheckinMessageTask(schedule.task)) {
        const compactMessage = (success ? effectiveTaskOutput : RANDOM_CHECKIN_FALLBACK_MESSAGE)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, RANDOM_CHECKIN_MAX_TELEGRAM_CHARS)
          || RANDOM_CHECKIN_FALLBACK_MESSAGE;
        try {
          await notifyUser(schedule.userId, compactMessage);
        } catch (err) {
          const warningMsg = `Telegram notify failed for random check-in: ${err instanceof Error ? err.message : String(err)}`;
          deliveryWarnings.push(warningMsg);
          logError("task-scheduler", "task_output_delivery_failed", {
            id: schedule.id,
            channel: "telegram",
            error: warningMsg,
          });
        }
      } else {
        try {
          await notifyUser(schedule.userId, message);
        } catch (err) {
          const warningMsg = `Telegram notify failed: ${err instanceof Error ? err.message : String(err)}`;
          deliveryWarnings.push(warningMsg);
          logError("task-scheduler", "task_output_delivery_failed", {
            id: schedule.id,
            channel: "telegram",
            error: warningMsg,
          });
        }
      }
    }
  } else if (outputTarget === "silent") {
    // Log only, no notification
    debug("task-scheduler", "silent_output", { id: schedule.id, success });
  } else if (outputTarget.startsWith("file:")) {
    const filePath = outputTarget.slice(5);
    try {
      appendFileSync(filePath, `[${new Date().toISOString()}] Task #${schedule.id}${displayName} (${success ? "ok" : "fail"}):\n${effectiveTaskOutput}\n\n`);
    } catch (err) {
      const warningMsg = `File output failed (${filePath}): ${err instanceof Error ? err.message : String(err)}`;
      deliveryWarnings.push(warningMsg);
      logError("task-scheduler", "file_output_error", {
        id: schedule.id,
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      logError("task-scheduler", "task_output_delivery_failed", {
        id: schedule.id,
        channel: "file",
        error: warningMsg,
      });
    }
  } else if (outputTarget.startsWith("email:")) {
    const address = outputTarget.slice(6);
    const subject = `Schedule #${schedule.id}: ${schedule.name || schedule.task.substring(0, 50)}`;
    const body = `${success ? "Success" : "Failed"} (${(durationMs / 1000).toFixed(1)}s)\n\n${effectiveTaskOutput}`;
    await new Promise<void>((resolve) => {
      execFile(
        "/opt/homebrew/bin/gog",
        ["gmail", "send", "--to", address, "--subject", subject, "--body", body, "--account", process.env.GOG_ACCOUNT || address],
        (err) => {
          if (err) {
            const warningMsg = `Email output failed (${address}): ${err.message}`;
            deliveryWarnings.push(warningMsg);
            logError("task-scheduler", "email_output_error", {
              id: schedule.id,
              address,
              error: err.message,
            });
            logError("task-scheduler", "task_output_delivery_failed", {
              id: schedule.id,
              channel: "email",
              error: warningMsg,
            });
          }
          resolve();
        }
      );
    });
  }
  return deliveryWarnings;
}

// --- Task execution wrapper ---

async function runScheduledTask(scheduleId: number): Promise<void> {
  if (runningSchedules.has(scheduleId)) {
    warn("task-scheduler", "task_already_running_skip", { id: scheduleId });
    return;
  }
  runningSchedules.add(scheduleId);
  const startTime = Date.now();

  let leaseToken = "";
  let activeSchedule: Schedule | null = null;
  try {
    const lease = claimRunLease(scheduleId);
    if (!lease.claimed || !lease.schedule) {
      if (lease.reason === "lease_active") {
        warn("task-scheduler", "task_skipped_lease_active", {
          id: scheduleId,
          leaseToken: lease.existingLeaseToken,
        });
      } else {
        debug("task-scheduler", "task_skipped_not_active", { id: scheduleId, reason: lease.reason });
      }
      return;
    }

    activeSchedule = lease.schedule;
    leaseToken = activeSchedule.runLeaseToken || "";
    const outputTarget = activeSchedule.output ?? "telegram";
    const displayName = activeSchedule.name ? ` (${activeSchedule.name})` : "";
    const isRandomMaster = isRandomCheckinMasterTask(activeSchedule.task);
    const isRandomMessage = isRandomCheckinMessageTask(activeSchedule.task);

    info("task-scheduler", "task_starting", {
      id: activeSchedule.id,
      jobType: activeSchedule.jobType ?? "prompt",
      task: activeSchedule.task.substring(0, 80),
    });

    if (notifyUser && outputTarget !== "silent" && !isRandomMaster && !isRandomMessage) {
      try {
        await notifyUser(
          activeSchedule.userId,
          `\u23F3 Scheduled task #${activeSchedule.id}${displayName} starting: ${activeSchedule.task}`
        );
      } catch (err) {
        logError("task-scheduler", "task_output_delivery_failed", {
          id: activeSchedule.id,
          channel: "telegram_start",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let result: TaskExecutionResult;
    if (isRandomMaster) {
      result = await executeRandomCheckinPlannerTask(activeSchedule.userId);
    } else {
      const jobType = activeSchedule.jobType ?? "prompt";
      switch (jobType) {
        case "shell":
          result = await executeShellTask(activeSchedule.task);
          break;
        case "script":
          result = await executeScriptTask(activeSchedule.task);
          break;
        case "prompt":
        default: {
          const promptTask = getTaskPromptForExecution(activeSchedule.task);
          const firstAttempt = await executeClaudeTask(promptTask);
          if (shouldRetryPromptTask(firstAttempt)) {
            info("task-scheduler", "prompt_task_retrying", {
              id: activeSchedule.id,
              firstAttemptDurationMs: firstAttempt.attemptDurationMs,
              firstFailureKind: firstAttempt.failureKind,
            });
            const secondAttempt = await executeClaudeTask(promptTask);
            result = {
              ...secondAttempt,
              attempts: 2,
              output: secondAttempt.success
                ? secondAttempt.output
                : [
                    "Attempt 1 failed fast; retried once.",
                    `Attempt 1: ${firstAttempt.output.trim() || "(no details)"}`,
                    `Attempt 2: ${secondAttempt.output.trim() || "(no details)"}`,
                  ].join("\n"),
              attemptDurationMs: firstAttempt.attemptDurationMs + secondAttempt.attemptDurationMs,
            };
          } else {
            result = firstAttempt;
          }
          break;
        }
      }
    }

    const duration = Date.now() - startTime;
    let deliveryWarnings: string[] = [];
    try {
      deliveryWarnings = await routeOutput(activeSchedule, result.output, result.success, duration);
    } catch (err) {
      const warningMsg = `Output routing failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`;
      deliveryWarnings = [warningMsg];
      logError("task-scheduler", "task_output_delivery_failed", {
        id: activeSchedule.id,
        channel: "unknown",
        error: warningMsg,
      });
    }

    let historyResult = result.output || "(no output)";
    if (deliveryWarnings.length > 0) {
      const warningBlock = `\n\nDelivery warnings:\n- ${deliveryWarnings.join("\n- ")}`;
      historyResult += warningBlock;
      if (result.success) {
        result.failureKind = "delivery_failed";
      }
    }
    const metadataLine = `Execution metadata: jobType=${result.jobType}, success=${result.success}, failureKind=${result.failureKind}, attempts=${result.attempts}`;
    historyResult = `${metadataLine}\n${historyResult}`;

    finalizeRunLease(activeSchedule.id, leaseToken, result, historyResult, duration);

    info("task-scheduler", "task_completed", {
      id: activeSchedule.id,
      durationMs: duration,
      success: result.success,
      failureKind: result.failureKind,
      attempts: result.attempts,
    });
  } catch (err) {
    const duration = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logError("task-scheduler", "task_failed", {
      id: scheduleId,
      error: errorMsg,
    });

    const failureResult: TaskExecutionResult = {
      success: false,
      output: `Error: ${errorMsg}`,
      jobType: activeSchedule?.jobType ?? "prompt",
      failureKind: "exception",
      attempts: 1,
      attemptDurationMs: duration,
      exitCode: null,
      signal: null,
    };

    if (leaseToken) {
      finalizeRunLease(scheduleId, leaseToken, failureResult, failureResult.output, duration);
    }

    if (notifyUser && activeSchedule) {
      const isRandomMaster = isRandomCheckinMasterTask(activeSchedule.task);
      const isRandomMessage = isRandomCheckinMessageTask(activeSchedule.task);
      const displayName = activeSchedule.name ? ` (${activeSchedule.name})` : "";
      if (!isRandomMaster && !isRandomMessage) {
        try {
          await notifyUser(
            activeSchedule.userId,
            `\u274C Task #${activeSchedule.id}${displayName} failed: ${errorMsg}`
          );
        } catch {
          // Notification failure is already non-fatal; execution failure is persisted above.
        }
      }
    }
  } finally {
    runningSchedules.delete(scheduleId);
  }
}

// --- Scheduling logic ---

function scheduleCronTask(schedule: Schedule): void {
  if (!schedule.cronExpression) {
    logError("task-scheduler", "missing_cron_expression", { id: schedule.id });
    mutateSchedules((store) => {
      const stored = store.schedules.find((s) => s.id === schedule.id);
      if (!stored || stored.status !== "active") return;
      stored.status = "failed";
      stored.nextRun = undefined;
      pushScheduleHistoryEntry(stored, {
        timestamp: new Date().toISOString(),
        result: "Schedule is missing cronExpression",
        duration: 0,
        success: false,
      });
      stored.lastFailureKind = "exception";
      stored.lastAttemptCount = 1;
    });
    return;
  }

  if (!cron.validate(schedule.cronExpression)) {
    logError("task-scheduler", "invalid_cron", {
      id: schedule.id,
      cron: schedule.cronExpression,
    });
    mutateSchedules((store) => {
      const stored = store.schedules.find((s) => s.id === schedule.id);
      if (!stored || stored.status !== "active") return;
      stored.status = "failed";
      stored.nextRun = undefined;
      pushScheduleHistoryEntry(stored, {
        timestamp: new Date().toISOString(),
        result: `Invalid cron expression: ${schedule.cronExpression}`,
        duration: 0,
        success: false,
      });
      stored.lastFailureKind = "exception";
      stored.lastAttemptCount = 1;
    });
    return;
  }

  const existing = activeCronJobs.get(schedule.id);
  if (existing) {
    existing.stop();
    activeCronJobs.delete(schedule.id);
  }

  const job = cron.schedule(
    schedule.cronExpression,
    () => {
      runScheduledTask(schedule.id).catch((err) => {
        logError("task-scheduler", "cron_task_error", {
          id: schedule.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    { timezone: TIMEZONE }
  );

  activeCronJobs.set(schedule.id, job);

  // Update nextRun using node-cron v4's getNextRun()
  try {
    const nextRun = job.getNextRun();
    if (nextRun) {
      mutateSchedules((store) => {
        const stored = store.schedules.find((s) => s.id === schedule.id);
        if (!stored || stored.status !== "active") return;
        stored.nextRun = nextRun.toISOString();
      });
    }
  } catch {
    // getNextRun may not be available, ignore
  }

  info("task-scheduler", "cron_scheduled", {
    id: schedule.id,
    cron: schedule.cronExpression,
  });
}

function scheduleOnceTask(schedule: Schedule): void {
  if (!schedule.scheduledTime) {
    logError("task-scheduler", "missing_once_scheduled_time", { id: schedule.id });
    mutateSchedules((store) => {
      const stored = store.schedules.find((s) => s.id === schedule.id);
      if (!stored || stored.status !== "active") return;
      stored.status = "failed";
      stored.nextRun = undefined;
      pushScheduleHistoryEntry(stored, {
        timestamp: new Date().toISOString(),
        result: "Schedule is missing scheduledTime",
        duration: 0,
        success: false,
      });
      stored.lastFailureKind = "exception";
      stored.lastAttemptCount = 1;
    });
    return;
  }

  const targetTime = new Date(schedule.scheduledTime).getTime();
  if (Number.isNaN(targetTime)) {
    logError("task-scheduler", "invalid_once_schedule_time", {
      id: schedule.id,
      scheduledTime: schedule.scheduledTime,
    });
    mutateSchedules((store) => {
      const stored = store.schedules.find((s) => s.id === schedule.id);
      if (!stored || stored.status !== "active") return;
      stored.status = "failed";
      stored.nextRun = undefined;
      pushScheduleHistoryEntry(stored, {
        timestamp: new Date().toISOString(),
        result: `Invalid scheduledTime: ${schedule.scheduledTime}`,
        duration: 0,
        success: false,
      });
      stored.lastFailureKind = "exception";
      stored.lastAttemptCount = 1;
    });
    return;
  }

  const existing = activeTimers.get(schedule.id);
  if (existing) {
    clearTimeout(existing);
    activeTimers.delete(schedule.id);
  }

  const scheduleChunk = () => {
    const remaining = targetTime - Date.now();
    if (remaining <= 0) {
      activeTimers.delete(schedule.id);
      info("task-scheduler", "running_overdue_task", { id: schedule.id });
      runScheduledTask(schedule.id).catch((err) => {
        logError("task-scheduler", "overdue_task_error", {
          id: schedule.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }

    const delay = Math.min(remaining, MAX_SET_TIMEOUT_MS);
    const timer = setTimeout(() => {
      if (remaining > MAX_SET_TIMEOUT_MS) {
        scheduleChunk();
        return;
      }
      activeTimers.delete(schedule.id);
      runScheduledTask(schedule.id).catch((err) => {
        logError("task-scheduler", "once_task_error", {
          id: schedule.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delay);

    timer.unref();
    activeTimers.set(schedule.id, timer);

    if (remaining > MAX_SET_TIMEOUT_MS) {
      debug("task-scheduler", "once_schedule_chunked_timer", {
        id: schedule.id,
        remainingMs: remaining,
        chunkDelayMs: delay,
      });
    }
  };

  scheduleChunk();

  info("task-scheduler", "once_scheduled", {
    id: schedule.id,
    scheduledTime: schedule.scheduledTime,
    delayMs: Math.max(targetTime - Date.now(), 0),
  });
}

function stopScheduleRuntime(scheduleId: number): void {
  const cronJob = activeCronJobs.get(scheduleId);
  if (cronJob) {
    cronJob.stop();
    activeCronJobs.delete(scheduleId);
  }

  const timer = activeTimers.get(scheduleId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(scheduleId);
  }
}

export function getTaskSchedulerHealthSnapshot(): {
  activeSchedules: number;
  attachedCronHandles: number;
  attachedTimerHandles: number;
  leasedSchedules: number;
  runningSchedules: number;
  reconcileLastRunAt?: string;
  reconcileRepairsLastInterval: number;
  reconcileStats: SchedulerReconcileStats;
} {
  const store = loadSchedules();
  const activeSchedules = store.schedules.filter((s) => s.status === "active");
  const leasedSchedules = activeSchedules.filter((s) => Boolean(s.runLeaseToken)).length;
  const reconcileRepairsLastInterval =
    lastReconcileStats.repairedCronJobs
    + lastReconcileStats.repairedTimers
    + lastReconcileStats.removedOrphanCronJobs
    + lastReconcileStats.removedOrphanTimers
    + lastReconcileStats.staleLeasesRecovered;

  return {
    activeSchedules: activeSchedules.length,
    attachedCronHandles: activeCronJobs.size,
    attachedTimerHandles: activeTimers.size,
    leasedSchedules,
    runningSchedules: runningSchedules.size,
    reconcileLastRunAt: lastReconcileStats.cycleStartedAt,
    reconcileRepairsLastInterval,
    reconcileStats: { ...lastReconcileStats },
  };
}

function reconcileSchedulerRuntime(): void {
  const cycleStartedAt = new Date().toISOString();
  const staleLeasesRecovered = recoverStaleLeases();
  const store = loadSchedules();
  const activeSchedules = store.schedules.filter((s) => s.status === "active");
  const activeById = new Map<number, Schedule>(activeSchedules.map((s) => [s.id, s]));
  const activeCronIds = new Set<number>(activeSchedules.filter((s) => s.type === "cron").map((s) => s.id));
  const activeTimerIds = new Set<number>(activeSchedules.filter((s) => s.type === "once").map((s) => s.id));

  let repairedCronJobs = 0;
  let repairedTimers = 0;
  let removedOrphanCronJobs = 0;
  let removedOrphanTimers = 0;
  let overdueTriggered = 0;

  for (const [id, job] of activeCronJobs) {
    if (activeCronIds.has(id)) continue;
    job.stop();
    activeCronJobs.delete(id);
    removedOrphanCronJobs++;
  }

  for (const [id, timer] of activeTimers) {
    if (activeTimerIds.has(id)) continue;
    clearTimeout(timer);
    activeTimers.delete(id);
    removedOrphanTimers++;
  }

  for (const schedule of activeSchedules) {
    if (schedule.type === "cron") {
      if (!activeCronJobs.has(schedule.id)) {
        scheduleCronTask(schedule);
        repairedCronJobs++;
      }
      continue;
    }

    if (activeTimers.has(schedule.id)) continue;
    const dueTs = schedule.scheduledTime ? new Date(schedule.scheduledTime).getTime() : NaN;
    if (Number.isFinite(dueTs) && dueTs <= Date.now()) {
      overdueTriggered++;
      runScheduledTask(schedule.id).catch((err) => {
        logError("task-scheduler", "reconcile_overdue_task_error", {
          id: schedule.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      continue;
    }

    scheduleOnceTask(schedule);
    repairedTimers++;
  }

  // Also remove dangling handles for schedules that disappeared from store entirely.
  for (const [id, job] of activeCronJobs) {
    if (activeById.has(id)) continue;
    job.stop();
    activeCronJobs.delete(id);
    removedOrphanCronJobs++;
  }
  for (const [id, timer] of activeTimers) {
    if (activeById.has(id)) continue;
    clearTimeout(timer);
    activeTimers.delete(id);
    removedOrphanTimers++;
  }

  lastReconcileStats = {
    cycleStartedAt,
    activeSchedules: activeSchedules.length,
    repairedCronJobs,
    repairedTimers,
    removedOrphanCronJobs,
    removedOrphanTimers,
    staleLeasesRecovered,
    overdueTriggered,
  };

  info("task-scheduler", "runtime_reconcile", {
    activeSchedules: activeSchedules.length,
    repairedCronJobs,
    repairedTimers,
    removedOrphanCronJobs,
    removedOrphanTimers,
    staleLeasesRecovered,
    overdueTriggered,
  });
}

export function triggerTaskSchedulerReconcile(): void {
  reconcileSchedulerRuntime();
}

// --- Public API ---

/**
 * Set the notification callback (called from bot initialization).
 */
export function setTaskNotifier(
  callback: (userId: string, message: string) => Promise<void>
): void {
  notifyUser = callback;
}

export function setTaskTelegramApiContextProvider(
  provider: () => TelegramApiContextLike & { botId?: number }
): void {
  telegramApiContextProvider = provider;
}

/**
 * Cancel a schedule by ID.
 */
export function cancelSchedule(
  scheduleId: number,
  userId: string
): { success: boolean; message: string } {
  const result = mutateSchedules((store) => {
    const schedule = store.schedules.find(
      (s) => s.id === scheduleId && s.userId === userId
    );

    if (!schedule) {
      return { success: false, message: `Schedule #${scheduleId} not found.` };
    }

    if (schedule.status !== "active") {
      return {
        success: false,
        message: `Schedule #${scheduleId} is already ${schedule.status}.`,
      };
    }

    stopScheduleRuntime(scheduleId);
    schedule.status = "cancelled";
    schedule.nextRun = undefined;
    return { success: true, message: `Schedule #${scheduleId} cancelled.` };
  });

  if (result.success) {
    info("task-scheduler", "schedule_cancelled", { id: scheduleId });
  }
  return result;
}

/**
 * Get all schedules for a user (active ones first).
 */
export function getSchedules(userId: string): Schedule[] {
  const store = loadSchedules();
  return store.schedules
    .filter((s) => s.userId === userId)
    .sort((a, b) => {
      // Active first, then by creation date descending
      if (a.status === "active" && b.status !== "active") return -1;
      if (b.status === "active" && a.status !== "active") return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
}

/**
 * Get a single schedule by ID.
 */
export function getScheduleById(
  scheduleId: number,
  userId: string
): Schedule | undefined {
  const store = loadSchedules();
  return store.schedules.find(
    (s) => s.id === scheduleId && s.userId === userId
  );
}

/**
 * Format a schedule for display.
 */
export function formatSchedule(schedule: Schedule): string {
  const typeIcon = schedule.type === "cron" ? "\u{1F504}" : "\u{23F0}";
  const statusIcon =
    schedule.status === "active"
      ? "\u{1F7E2}"
      : schedule.status === "completed"
        ? "\u{2705}"
        : schedule.status === "cancelled"
          ? "\u{274C}"
          : "\u{1F534}";

  let timeInfo: string;
  if (schedule.type === "cron") {
    timeInfo = `cron: \`${schedule.cronExpression}\``;
  } else {
    const time = schedule.scheduledTime
      ? new Date(schedule.scheduledTime).toLocaleString("en-GB", {
          timeZone: TIMEZONE,
          dateStyle: "short",
          timeStyle: "short",
        })
      : "unknown";
    timeInfo = `at ${time}`;
  }

  const nameStr = schedule.name ? ` "${schedule.name}"` : "";
  let lines = `${statusIcon} #${schedule.id}${nameStr} ${typeIcon} ${timeInfo}\n  ${schedule.task}`;

  // Show non-default jobType and output
  const jobType = schedule.jobType ?? "prompt";
  const outputTarget = schedule.output ?? "telegram";
  const extras: string[] = [];
  if (jobType !== "prompt") extras.push(`job: ${jobType}`);
  if (outputTarget !== "telegram") extras.push(`output: ${outputTarget}`);
  if (extras.length > 0) {
    lines += `\n  [${extras.join(", ")}]`;
  }

  if (schedule.lastRun) {
    const lastRunStr = new Date(schedule.lastRun).toLocaleString("en-GB", {
      timeZone: TIMEZONE,
      dateStyle: "short",
      timeStyle: "short",
    });
    lines += `\n  Last run: ${lastRunStr}`;
  }

  if (schedule.nextRun && schedule.status === "active") {
    const nextRunStr = new Date(schedule.nextRun).toLocaleString("en-GB", {
      timeZone: TIMEZONE,
      dateStyle: "short",
      timeStyle: "short",
    });
    lines += `\n  Next run: ${nextRunStr}`;
  }

  return lines;
}

/**
 * Format execution history for a schedule.
 */
export function formatHistory(schedule: Schedule, limit: number = 10): string {
  if (schedule.history.length === 0) {
    return `No execution history for schedule #${schedule.id}.`;
  }

  const recent = schedule.history.slice(-limit).reverse();
  const lines = recent.map((entry) => {
    const icon = entry.success ? "\u{2705}" : "\u{274C}";
    const time = new Date(entry.timestamp).toLocaleString("en-GB", {
      timeZone: TIMEZONE,
      dateStyle: "short",
      timeStyle: "short",
    });
    const duration = (entry.duration / 1000).toFixed(1);
    const result =
      entry.result.length > 200
        ? entry.result.substring(0, 200) + "..."
        : entry.result;
    return `${icon} ${time} (${duration}s)\n${result}`;
  });

  return `History for #${schedule.id} (last ${recent.length}):\n\n${lines.join("\n\n")}`;
}

/**
 * Reload schedules from disk. Stops all active jobs/timers and re-registers active schedules.
 * Useful for hot-reloading after external schedule file changes (e.g. via SIGUSR2).
 */
export function reloadSchedules(): void {
  // Stop all active cron jobs and timers
  for (const [, job] of activeCronJobs) job.stop();
  activeCronJobs.clear();
  for (const [, timer] of activeTimers) clearTimeout(timer);
  activeTimers.clear();

  // Re-read from disk and resume active schedules
  const store = loadSchedules();
  let resumed = 0;
  for (const schedule of store.schedules) {
    if (schedule.status !== "active") continue;
    if (schedule.type === "cron") {
      scheduleCronTask(schedule);
      resumed++;
    } else if (schedule.type === "once") {
      scheduleOnceTask(schedule);
      resumed++;
    }
  }
  reconcileRandomCheckinsForToday();
  reconcileSchedulerRuntime();
  info("task-scheduler", "reloaded", { activeResumed: resumed });
}

/**
 * Initialize the task scheduler: load persisted schedules, resume active ones.
 */
export function initTaskScheduler(): void {
  ensureStorageDir();
  recoverStaleLeases();
  const store = loadSchedules();

  let resumed = 0;
  for (const schedule of store.schedules) {
    if (schedule.status !== "active") continue;

    if (schedule.type === "cron") {
      scheduleCronTask(schedule);
      resumed++;
    } else if (schedule.type === "once") {
      scheduleOnceTask(schedule);
      resumed++;
    }
  }

  reconcileRandomCheckinsForToday();
  reconcileSchedulerRuntime();

  if (!runtimeReconcilerTimer) {
    runtimeReconcilerTimer = setInterval(() => {
      reconcileSchedulerRuntime();
    }, SCHEDULER_RECONCILE_INTERVAL_MS);
    runtimeReconcilerTimer.unref();
  }

  info("task-scheduler", "initialized", {
    totalSchedules: store.schedules.length,
    activeResumed: resumed,
    reconcileIntervalMs: SCHEDULER_RECONCILE_INTERVAL_MS,
  });
}

/**
 * Stop all scheduled tasks cleanly (called during shutdown).
 */
export function stopTaskScheduler(): void {
  const cronCount = activeCronJobs.size;
  const timerCount = activeTimers.size;

  for (const [id, job] of activeCronJobs) {
    job.stop();
    debug("task-scheduler", "stopped_cron", { id });
  }
  activeCronJobs.clear();

  for (const [id, timer] of activeTimers) {
    clearTimeout(timer);
    debug("task-scheduler", "stopped_timer", { id });
  }
  activeTimers.clear();

  if (runtimeReconcilerTimer) {
    clearInterval(runtimeReconcilerTimer);
    runtimeReconcilerTimer = null;
  }

  info("task-scheduler", "stopped", {
    cronJobs: cronCount,
    timers: timerCount,
  });
}
