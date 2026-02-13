/**
 * Standalone CLI for managing gateway schedules.
 * Reads/writes ~/.claude/gateway/schedules.json and signals the running gateway to hot-reload.
 *
 * Usage:
 *   node dist/schedule-cli.js create --name "..." --type cron --cron "..." --job prompt --cmd "..." --output telegram --user <id>
 *   node dist/schedule-cli.js list [--active] [--user <id>]
 *   node dist/schedule-cli.js cancel <id>
 *   node dist/schedule-cli.js update <id> [--name "..."] [--cron "..."] [--time "YYYY-MM-DD HH:MM"] [--cmd "..."] [--output ...] [--job ...]
 *   node dist/schedule-cli.js history <id> [--limit 10]
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { validate as validateCron } from "node-cron";

// --- Types (mirrored from task-scheduler.ts) ---

interface ScheduleHistoryEntry {
  timestamp: string;
  result: string;
  duration: number;
  success: boolean;
}

interface Schedule {
  id: number;
  type: "once" | "cron";
  jobType: "prompt" | "shell" | "script";
  cronExpression?: string;
  scheduledTime?: string;
  task: string;
  output: "telegram" | "silent" | string;
  name?: string;
  status: "active" | "completed" | "cancelled" | "failed";
  createdAt: string;
  lastRun?: string;
  nextRun?: string;
  userId: string;
  history: ScheduleHistoryEntry[];
}

interface ScheduleStore {
  schedules: Schedule[];
  nextId: number;
}

// --- Constants ---

const SCHEDULES_DIR = join(homedir(), ".claude", "gateway");
const SCHEDULES_PATH = join(SCHEDULES_DIR, "schedules.json");
const SCHEDULES_LOCK_PATH = join(SCHEDULES_DIR, "schedules.lock");
const PID_FILE = process.env.TG_PID_FILE || join(__dirname, "..", "gateway.pid");
const TIMEZONE = "Europe/Berlin";
const STORE_LOCK_TIMEOUT_MS = 5_000;
const STORE_LOCK_RETRY_MS = 25;
const STORE_LOCK_STALE_MS = 30_000;

// --- Helpers ---

function output(data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function fail(message: string): never {
  throw new CliError(message);
}

function ensureDir(): void {
  if (!existsSync(SCHEDULES_DIR)) {
    mkdirSync(SCHEDULES_DIR, { recursive: true });
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withStoreLock<T>(operation: () => T): T {
  ensureDir();
  const startedAt = Date.now();

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
          // Ignore lock cleanup race.
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
          continue;
        }
      } catch {
        // Lock disappeared between checks.
      }

      if (Date.now() - startedAt >= STORE_LOCK_TIMEOUT_MS) {
        fail(`Timed out acquiring schedule store lock after ${STORE_LOCK_TIMEOUT_MS}ms.`);
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

  const schedule: Schedule = {
    id,
    type: value.type,
    jobType: value.jobType === "shell" || value.jobType === "script" || value.jobType === "prompt"
      ? value.jobType
      : "prompt",
    task: value.task,
    output: typeof value.output === "string" && value.output.trim().length > 0 ? value.output : "telegram",
    name: typeof value.name === "string" ? value.name : undefined,
    status: value.status === "active" || value.status === "completed" || value.status === "cancelled" || value.status === "failed"
      ? value.status
      : "active",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    lastRun: typeof value.lastRun === "string" ? value.lastRun : undefined,
    nextRun: typeof value.nextRun === "string" ? value.nextRun : undefined,
    userId: value.userId,
    history: Array.isArray(value.history)
      ? value.history.filter((entry): entry is ScheduleHistoryEntry => (
        !!entry
        && typeof entry === "object"
        && typeof (entry as Partial<ScheduleHistoryEntry>).timestamp === "string"
        && typeof (entry as Partial<ScheduleHistoryEntry>).result === "string"
        && typeof (entry as Partial<ScheduleHistoryEntry>).duration === "number"
        && typeof (entry as Partial<ScheduleHistoryEntry>).success === "boolean"
      ))
      : [],
  };

  if (schedule.type === "cron" && typeof value.cronExpression === "string") {
    schedule.cronExpression = value.cronExpression;
  }
  if (schedule.type === "once" && typeof value.scheduledTime === "string") {
    schedule.scheduledTime = value.scheduledTime;
  }

  return schedule;
}

function loadStoreUnsafe(): ScheduleStore {
  ensureDir();
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
  } catch {
    return { schedules: [], nextId: 1 };
  }
}

function saveStoreUnsafe(store: ScheduleStore): void {
  ensureDir();
  const tempPath = join(dirname(SCHEDULES_PATH), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tempPath, JSON.stringify(store, null, 2));
  renameSync(tempPath, SCHEDULES_PATH);
}

function mutateStore<T>(mutator: (store: ScheduleStore) => T): T {
  return withStoreLock(() => {
    const store = loadStoreUnsafe();
    const result = mutator(store);
    saveStoreUnsafe(store);
    return result;
  });
}

function loadStore(): ScheduleStore {
  return loadStoreUnsafe();
}

function signalGateway(): void {
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (pid > 0) {
        process.kill(pid, "SIGUSR2");
      }
    }
  } catch {
    // Gateway might not be running - that's fine
  }
}

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Record<string, string> } {
  const command = argv[0] || "";
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = "true";
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }

  return { command, positional, flags };
}

/**
 * Convert "YYYY-MM-DD HH:MM" in Europe/Berlin to an ISO string.
 */
function parseBerlinTime(timeStr: string): string {
  const match = timeStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) {
    fail(`Invalid time format: "${timeStr}". Expected "YYYY-MM-DD HH:MM".`);
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    fail(`Invalid time value: "${timeStr}".`);
  }

  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parseParts = (date: Date): Record<string, string> => {
    const parts = formatter.formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    return map;
  };
  const getOffsetMs = (date: Date): number => {
    const parts = parseParts(date);
    const asUtc = Date.UTC(
      parseInt(parts.year, 10),
      parseInt(parts.month, 10) - 1,
      parseInt(parts.day, 10),
      parseInt(parts.hour, 10),
      parseInt(parts.minute, 10),
      parseInt(parts.second, 10),
    );
    return asUtc - date.getTime();
  };

  // Iterative conversion: local Berlin wall-time -> UTC instant.
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utcMillis = localAsUtc - getOffsetMs(new Date(localAsUtc));
  utcMillis = localAsUtc - getOffsetMs(new Date(utcMillis));
  const result = new Date(utcMillis);
  const resultParts = parseParts(result);

  // Reject non-existent local times (DST spring-forward gaps).
  if (
    parseInt(resultParts.year, 10) !== year
    || parseInt(resultParts.month, 10) !== month
    || parseInt(resultParts.day, 10) !== day
    || parseInt(resultParts.hour, 10) !== hour
    || parseInt(resultParts.minute, 10) !== minute
  ) {
    fail(`Invalid local Berlin time: "${timeStr}" (possibly during DST transition).`);
  }

  return result.toISOString();
}

// --- Commands ---

function cmdCreate(flags: Record<string, string>): void {
  const type = flags["type"] as "once" | "cron" | undefined;
  if (!type || (type !== "once" && type !== "cron")) {
    fail("--type is required (cron or once).");
  }

  const cmd = flags["cmd"];
  if (!cmd) {
    fail("--cmd is required.");
  }

  const user = flags["user"];
  if (!user) {
    fail("--user is required.");
  }

  const jobType = (flags["job"] || "prompt") as "prompt" | "shell" | "script";
  if (!["prompt", "shell", "script"].includes(jobType)) {
    fail("--job must be prompt, shell, or script.");
  }

  const outputTarget = flags["output"] || "telegram";
  const name = flags["name"];
  let cronExpr: string | undefined;
  let scheduledTime: string | undefined;
  if (type === "cron") {
    cronExpr = flags["cron"];
    if (!cronExpr) {
      fail("--cron is required for type=cron.");
    }
    if (!validateCron(cronExpr)) {
      fail(`Invalid cron expression: "${cronExpr}".`);
    }
  } else {
    const time = flags["time"];
    if (!time) {
      fail("--time is required for type=once (format: \"YYYY-MM-DD HH:MM\").");
    }
    scheduledTime = parseBerlinTime(time);
  }

  const schedule = mutateStore((store) => {
    const created: Schedule = {
      id: store.nextId++,
      type,
      jobType,
      task: cmd,
      output: outputTarget,
      status: "active",
      createdAt: new Date().toISOString(),
      userId: user,
      history: [],
    };
    if (name) {
      created.name = name;
    }
    if (type === "cron") {
      created.cronExpression = cronExpr;
    } else {
      created.scheduledTime = scheduledTime;
      created.nextRun = scheduledTime;
    }

    store.schedules.push(created);
    return created;
  });

  signalGateway();

  output({ ok: true, schedule });
}

function cmdList(flags: Record<string, string>): void {
  const store = loadStore();
  let schedules = store.schedules;

  if (flags["active"] !== undefined) {
    schedules = schedules.filter((s) => s.status === "active");
  }

  if (flags["user"]) {
    schedules = schedules.filter((s) => s.userId === flags["user"]);
  }

  // Sort: active first, then by creation date descending
  schedules.sort((a, b) => {
    if (a.status === "active" && b.status !== "active") return -1;
    if (b.status === "active" && a.status !== "active") return 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  output({ ok: true, schedules });
}

function cmdCancel(positional: string[]): void {
  const idStr = positional[0];
  if (!idStr) {
    fail("Schedule ID is required. Usage: cancel <id>");
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    fail(`Invalid schedule ID: "${idStr}".`);
  }

  const schedule = mutateStore((store) => {
    const found = store.schedules.find((s) => s.id === id);

    if (!found) {
      fail(`Schedule #${id} not found.`);
    }

    if (found.status !== "active") {
      fail(`Schedule #${id} is already ${found.status}.`);
    }

    found.status = "cancelled";
    found.nextRun = undefined;
    return found;
  });

  signalGateway();

  output({ ok: true, schedule });
}

function cmdUpdate(positional: string[], flags: Record<string, string>): void {
  const idStr = positional[0];
  if (!idStr) {
    fail("Schedule ID is required. Usage: update <id> [--name ...] [--cron ...] [--time \"YYYY-MM-DD HH:MM\"] [--cmd ...] [--output ...] [--job ...]");
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    fail(`Invalid schedule ID: "${idStr}".`);
  }

  const schedule = mutateStore((store) => {
    const found = store.schedules.find((s) => s.id === id);
    if (!found) {
      fail(`Schedule #${id} not found.`);
    }

    if (flags["name"] !== undefined) {
      found.name = flags["name"];
    }

    if (flags["cmd"] !== undefined) {
      found.task = flags["cmd"];
    }

    if (flags["output"] !== undefined) {
      found.output = flags["output"];
    }

    if (flags["job"] !== undefined) {
      const jobType = flags["job"] as "prompt" | "shell" | "script";
      if (!["prompt", "shell", "script"].includes(jobType)) {
        fail("--job must be prompt, shell, or script.");
      }
      found.jobType = jobType;
    }

    if (flags["cron"] !== undefined) {
      if (found.type !== "cron") {
        fail("--cron can only be used with type=cron schedules.");
      }
      if (!validateCron(flags["cron"])) {
        fail(`Invalid cron expression: "${flags["cron"]}".`);
      }
      found.cronExpression = flags["cron"];
    }

    if (flags["time"] !== undefined) {
      if (found.type !== "once") {
        fail("--time can only be used with type=once schedules.");
      }
      const parsed = parseBerlinTime(flags["time"]);
      found.scheduledTime = parsed;
      found.nextRun = parsed;
    }

    if (found.type === "cron") {
      found.scheduledTime = undefined;
    } else if (found.type === "once") {
      found.cronExpression = undefined;
    }

    return found;
  });

  signalGateway();

  output({ ok: true, schedule });
}

function cmdHistory(positional: string[], flags: Record<string, string>): void {
  const idStr = positional[0];
  if (!idStr) {
    fail("Schedule ID is required. Usage: history <id> [--limit 10]");
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    fail(`Invalid schedule ID: "${idStr}".`);
  }

  const store = loadStore();
  const schedule = store.schedules.find((s) => s.id === id);

  if (!schedule) {
    fail(`Schedule #${id} not found.`);
  }

  const limit = parseInt(flags["limit"] || "10", 10);
  const history = schedule.history.slice(-limit).reverse();

  output({ ok: true, id: schedule.id, name: schedule.name, history });
}

// --- Main ---

function main(): void {
  try {
    const argv = process.argv.slice(2);

    if (argv.length === 0) {
      fail("Usage: schedule-cli <create|list|cancel|update|history> [options]");
    }

    const { command, positional, flags } = parseArgs(argv);

    switch (command) {
      case "create":
        cmdCreate(flags);
        break;
      case "list":
        cmdList(flags);
        break;
      case "cancel":
        cmdCancel(positional);
        break;
      case "update":
        cmdUpdate(positional, flags);
        break;
      case "history":
        cmdHistory(positional, flags);
        break;
      default:
        fail(`Unknown command: "${command}". Valid commands: create, list, cancel, update, history.`);
    }
  } catch (err) {
    if (err instanceof CliError) {
      output({ ok: false, error: err.message });
      process.exit(1);
    }
    throw err;
  }
}

main();
