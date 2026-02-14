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

// --- State ---

// Active cron jobs keyed by schedule ID
const activeCronJobs: Map<number, cron.ScheduledTask> = new Map();
// Active one-time timers keyed by schedule ID
const activeTimers: Map<number, NodeJS.Timeout> = new Map();
// Running tasks keyed by schedule ID (prevents overlap on long cron jobs/reloads)
const runningSchedules: Set<number> = new Set();
// Notification callback - set by the bot integration
let notifyUser: ((userId: string, message: string) => Promise<void>) | null = null;
let telegramApiContextProvider: (() => TelegramApiContextLike & { botId?: number }) | null = null;

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
  if (value.type === "cron" && typeof value.cronExpression === "string") {
    schedule.cronExpression = value.cronExpression;
  }
  if (value.type === "once" && typeof value.scheduledTime === "string") {
    schedule.scheduledTime = value.scheduledTime;
  }

  return schedule;
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
async function executeClaudeTask(task: string): Promise<{ output: string; success: boolean }> {
  const config = getConfig();
  const claudePath = env.CLAUDE_BIN;

  return new Promise((resolve) => {
    let output = "";
    let resolved = false;

    const finish = (success: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve({ output: output.trim() || "(no output)", success });
    };

    const schedulerSystemPrompt = buildStaticSystemPrompt({
      providerDisplayName: config.providerDisplayName,
    });

    const proc = spawn(
      claudePath,
      [
        "--print",
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
              }
            }
          } else if (typeof content === "string") {
            output += content;
          }
        }

        // Content deltas
        if (msg.type === "content_block_delta" && msg.content) {
          output += msg.content;
        }

        // Result means done
        if (msg.type === "result") {
          if (msg.result) {
            output = msg.result;
          }
          proc.kill("SIGTERM");
          finish(true);
        }
      } catch {
        // Not JSON, ignore
      }
    });

    proc.on("close", () => {
      rl.close();
      finish(output.length > 0);
    });

    proc.on("error", (err) => {
      logError("task-scheduler", "claude_spawn_error", { error: err.message });
      finish(false);
    });

    // Timeout
    const timeout = setTimeout(() => {
      logError("task-scheduler", "task_timeout", { task });
      proc.kill("SIGKILL");
      output += "\n(task timed out)";
      finish(false);
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
        finish(false);
      }
      // Close stdin so Claude knows no more input is coming for this single-turn
      proc.stdin!.end();
    });
  });
}

// --- Shell / Script execution ---

/**
 * Execute a shell command with timeout.
 */
async function executeShellTask(command: string): Promise<{ output: string; success: boolean }> {
  return new Promise((resolve) => {
    exec(command, { timeout: TASK_TIMEOUT_MS, cwd: env.TG_WORKING_DIR }, (err, stdout, stderr) => {
      if (err) {
        const combined = (stdout + "\n" + stderr).trim() || err.message;
        resolve({ output: combined, success: false });
      } else {
        resolve({ output: (stdout + "\n" + stderr).trim() || "(no output)", success: true });
      }
    });
  });
}

/**
 * Execute a script file with the appropriate interpreter.
 */
async function executeScriptTask(scriptPath: string): Promise<{ output: string; success: boolean }> {
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
      return { output: `Unsupported script extension: ${ext}`, success: false };
  }
  return executeShellTask(command);
}

async function executeRandomCheckinPlannerTask(userId: string): Promise<{ output: string; success: boolean }> {
  const regenerated = regenerateRandomCheckinsForToday(userId);
  if (regenerated.generated > 0) {
    return {
      output: `Generated ${regenerated.generated} random check-ins for ${regenerated.dateKey}.`,
      success: true,
    };
  }
  return {
    output: regenerated.skippedReason
      ? `Skipped random check-in generation for ${regenerated.dateKey}: ${regenerated.skippedReason}`
      : `No random check-ins generated for ${regenerated.dateKey}.`,
    success: true,
  };
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
): Promise<void> {
  let effectiveTaskOutput = taskOutput;
  if ((schedule.jobType ?? "prompt") === "prompt") {
    effectiveTaskOutput = await executePromptTelegramApiTags(schedule, taskOutput);
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
      if (isRandomCheckinMessageTask(schedule.task) && success) {
        const compactMessage = effectiveTaskOutput
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, RANDOM_CHECKIN_MAX_TELEGRAM_CHARS)
          || "Quick check-in: take one small step on your top priority now.";
        await notifyUser(schedule.userId, compactMessage).catch(() => {});
      } else {
        await notifyUser(schedule.userId, message).catch(() => {});
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
      logError("task-scheduler", "file_output_error", {
        id: schedule.id,
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (outputTarget.startsWith("email:")) {
    const address = outputTarget.slice(6);
    const subject = `Schedule #${schedule.id}: ${schedule.name || schedule.task.substring(0, 50)}`;
    const body = `${success ? "Success" : "Failed"} (${(durationMs / 1000).toFixed(1)}s)\n\n${effectiveTaskOutput}`;
    execFile(
      "/opt/homebrew/bin/gog",
      ["gmail", "send", "--to", address, "--subject", subject, "--body", body, "--account", process.env.GOG_ACCOUNT || address],
      (err) => {
        if (err) {
          logError("task-scheduler", "email_output_error", {
            id: schedule.id,
            address,
            error: err.message,
          });
        }
      }
    );
  }
}

// --- Task execution wrapper ---

async function runScheduledTask(schedule: Schedule): Promise<void> {
  if (runningSchedules.has(schedule.id)) {
    warn("task-scheduler", "task_already_running_skip", { id: schedule.id });
    return;
  }
  runningSchedules.add(schedule.id);

  const startTime = Date.now();
  const outputTarget = schedule.output ?? "telegram";
  const displayName = schedule.name ? ` (${schedule.name})` : "";
  const isRandomMaster = isRandomCheckinMasterTask(schedule.task);
  const isRandomMessage = isRandomCheckinMessageTask(schedule.task);

  info("task-scheduler", "task_starting", {
    id: schedule.id,
    jobType: schedule.jobType ?? "prompt",
    task: schedule.task.substring(0, 80),
  });

  // Notify user that task is starting (unless silent)
  if (notifyUser && outputTarget !== "silent" && !isRandomMaster && !isRandomMessage) {
    await notifyUser(
      schedule.userId,
      `\u23F3 Scheduled task #${schedule.id}${displayName} starting: ${schedule.task}`
    ).catch(() => {});
  }

  try {
    // Dispatch based on jobType
    let result: { output: string; success: boolean };
    if (isRandomMaster) {
      result = await executeRandomCheckinPlannerTask(schedule.userId);
    } else {
      const jobType = schedule.jobType ?? "prompt";
      switch (jobType) {
        case "shell":
          result = await executeShellTask(schedule.task);
          break;
        case "script":
          result = await executeScriptTask(schedule.task);
          break;
        case "prompt":
        default:
          result = await executeClaudeTask(getTaskPromptForExecution(schedule.task));
          break;
      }
    }

    const { output, success } = result;
    const duration = Date.now() - startTime;

    // Record history
    const entry: ScheduleHistoryEntry = {
      timestamp: new Date().toISOString(),
      result: output.substring(0, 2000), // Cap result size
      duration,
      success,
    };

    mutateSchedules((store) => {
      const stored = store.schedules.find((s) => s.id === schedule.id);
      if (!stored) return;

      stored.history.push(entry);
      if (stored.history.length > MAX_HISTORY_PER_SCHEDULE) {
        stored.history = stored.history.slice(-MAX_HISTORY_PER_SCHEDULE);
      }
      stored.lastRun = entry.timestamp;

      if (stored.type === "once") {
        // Preserve cancelled state if user cancelled while task was executing.
        if (stored.status === "active") {
          stored.status = success ? "completed" : "failed";
        }
        stored.nextRun = undefined;
      } else if (stored.status === "active") {
        const cronJob = activeCronJobs.get(schedule.id);
        if (cronJob) {
          try {
            const nextRun = cronJob.getNextRun();
            stored.nextRun = nextRun ? nextRun.toISOString() : undefined;
          } catch {
            // getNextRun can throw for invalid/removed schedules.
          }
        }
      }
    });

    info("task-scheduler", "task_completed", {
      id: schedule.id,
      durationMs: duration,
      success,
    });

    // Route output
    await routeOutput(schedule, output, success, duration);
  } catch (err) {
    const duration = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    logError("task-scheduler", "task_failed", {
      id: schedule.id,
      error: errorMsg,
    });

    mutateSchedules((store) => {
      const stored = store.schedules.find((s) => s.id === schedule.id);
      if (!stored) return;

      stored.history.push({
        timestamp: new Date().toISOString(),
        result: `Error: ${errorMsg}`,
        duration,
        success: false,
      });
      if (stored.history.length > MAX_HISTORY_PER_SCHEDULE) {
        stored.history = stored.history.slice(-MAX_HISTORY_PER_SCHEDULE);
      }
      stored.lastRun = new Date().toISOString();
      if (stored.type === "once") {
        if (stored.status === "active") {
          stored.status = "failed";
        }
        stored.nextRun = undefined;
      } else if (stored.status === "active") {
        const cronJob = activeCronJobs.get(schedule.id);
        if (cronJob) {
          try {
            const nextRun = cronJob.getNextRun();
            stored.nextRun = nextRun ? nextRun.toISOString() : undefined;
          } catch {
            // getNextRun can throw for invalid/removed schedules.
          }
        }
      }
    });

    if (notifyUser && !isRandomMaster && !isRandomMessage) {
      await notifyUser(
        schedule.userId,
        `\u274C Task #${schedule.id}${displayName} failed: ${errorMsg}`
      ).catch(() => {});
    }
  } finally {
    runningSchedules.delete(schedule.id);
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
      stored.history.push({
        timestamp: new Date().toISOString(),
        result: "Schedule is missing cronExpression",
        duration: 0,
        success: false,
      });
      if (stored.history.length > MAX_HISTORY_PER_SCHEDULE) {
        stored.history = stored.history.slice(-MAX_HISTORY_PER_SCHEDULE);
      }
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
      stored.history.push({
        timestamp: new Date().toISOString(),
        result: `Invalid cron expression: ${schedule.cronExpression}`,
        duration: 0,
        success: false,
      });
      if (stored.history.length > MAX_HISTORY_PER_SCHEDULE) {
        stored.history = stored.history.slice(-MAX_HISTORY_PER_SCHEDULE);
      }
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
      runScheduledTask(schedule).catch((err) => {
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
      stored.history.push({
        timestamp: new Date().toISOString(),
        result: "Schedule is missing scheduledTime",
        duration: 0,
        success: false,
      });
      if (stored.history.length > MAX_HISTORY_PER_SCHEDULE) {
        stored.history = stored.history.slice(-MAX_HISTORY_PER_SCHEDULE);
      }
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
      stored.history.push({
        timestamp: new Date().toISOString(),
        result: `Invalid scheduledTime: ${schedule.scheduledTime}`,
        duration: 0,
        success: false,
      });
      if (stored.history.length > MAX_HISTORY_PER_SCHEDULE) {
        stored.history = stored.history.slice(-MAX_HISTORY_PER_SCHEDULE);
      }
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
      runScheduledTask(schedule).catch((err) => {
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
      runScheduledTask(schedule).catch((err) => {
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
  info("task-scheduler", "reloaded", { activeResumed: resumed });
}

/**
 * Initialize the task scheduler: load persisted schedules, resume active ones.
 */
export function initTaskScheduler(): void {
  ensureStorageDir();
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

  info("task-scheduler", "initialized", {
    totalSchedules: store.schedules.length,
    activeResumed: resumed,
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

  info("task-scheduler", "stopped", {
    cronJobs: cronCount,
    timers: timerCount,
  });
}
