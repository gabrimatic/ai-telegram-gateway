/**
 * Standalone CLI for managing gateway schedules.
 * Reads/writes ~/.claude/gateway/schedules.json and signals the running gateway to hot-reload.
 *
 * Usage:
 *   node dist/schedule-cli.js create --name "..." --type cron --cron "..." --job prompt --cmd "..." --output telegram --user <id>
 *   node dist/schedule-cli.js list [--active] [--user <id>]
 *   node dist/schedule-cli.js cancel <id>
 *   node dist/schedule-cli.js update <id> [--name "..."] [--cron "..."] [--cmd "..."] [--output ...] [--job ...]
 *   node dist/schedule-cli.js history <id> [--limit 10]
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
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
const PID_FILE = process.env.TG_PID_FILE || join(__dirname, "..", "gateway.pid");
const TIMEZONE = "Europe/Berlin";

// --- Helpers ---

function output(data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function fail(message: string): never {
  output({ ok: false, error: message });
  process.exit(1);
}

function ensureDir(): void {
  if (!existsSync(SCHEDULES_DIR)) {
    mkdirSync(SCHEDULES_DIR, { recursive: true });
  }
}

function loadStore(): ScheduleStore {
  ensureDir();
  if (!existsSync(SCHEDULES_PATH)) {
    return { schedules: [], nextId: 1 };
  }
  try {
    return JSON.parse(readFileSync(SCHEDULES_PATH, "utf-8")) as ScheduleStore;
  } catch {
    return { schedules: [], nextId: 1 };
  }
}

function saveStore(store: ScheduleStore): void {
  ensureDir();
  const tempPath = join(dirname(SCHEDULES_PATH), `.${Date.now()}.tmp`);
  writeFileSync(tempPath, JSON.stringify(store, null, 2));
  renameSync(tempPath, SCHEDULES_PATH);
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

  const [, year, month, day, hours, minutes] = match;
  const pad = (n: number) => n.toString().padStart(2, "0");
  const dateStr = `${year}-${pad(parseInt(month, 10))}-${pad(parseInt(day, 10))}T${pad(parseInt(hours, 10))}:${pad(parseInt(minutes, 10))}:00`;

  // Find UTC offset for Berlin at that time
  const tempDate = new Date(dateStr + "Z");
  const berlinStr = tempDate.toLocaleString("en-US", { timeZone: TIMEZONE });
  const berlinDate = new Date(berlinStr);
  const offsetMs = tempDate.getTime() - berlinDate.getTime();

  const result = new Date(tempDate.getTime() + offsetMs);
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

  const store = loadStore();
  const id = store.nextId++;

  const schedule: Schedule = {
    id,
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
    schedule.name = name;
  }

  if (type === "cron") {
    const cronExpr = flags["cron"];
    if (!cronExpr) {
      fail("--cron is required for type=cron.");
    }
    if (!validateCron(cronExpr)) {
      fail(`Invalid cron expression: "${cronExpr}".`);
    }
    schedule.cronExpression = cronExpr;
  } else {
    const time = flags["time"];
    if (!time) {
      fail("--time is required for type=once (format: \"YYYY-MM-DD HH:MM\").");
    }
    schedule.scheduledTime = parseBerlinTime(time);
    schedule.nextRun = schedule.scheduledTime;
  }

  store.schedules.push(schedule);
  saveStore(store);
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

  const store = loadStore();
  const schedule = store.schedules.find((s) => s.id === id);

  if (!schedule) {
    fail(`Schedule #${id} not found.`);
  }

  if (schedule.status !== "active") {
    fail(`Schedule #${id} is already ${schedule.status}.`);
  }

  schedule.status = "cancelled";
  saveStore(store);
  signalGateway();

  output({ ok: true, schedule });
}

function cmdUpdate(positional: string[], flags: Record<string, string>): void {
  const idStr = positional[0];
  if (!idStr) {
    fail("Schedule ID is required. Usage: update <id> [--name ...] [--cron ...] [--cmd ...] [--output ...] [--job ...]");
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

  if (flags["name"] !== undefined) {
    schedule.name = flags["name"];
  }

  if (flags["cmd"] !== undefined) {
    schedule.task = flags["cmd"];
  }

  if (flags["output"] !== undefined) {
    schedule.output = flags["output"];
  }

  if (flags["job"] !== undefined) {
    const jobType = flags["job"] as "prompt" | "shell" | "script";
    if (!["prompt", "shell", "script"].includes(jobType)) {
      fail("--job must be prompt, shell, or script.");
    }
    schedule.jobType = jobType;
  }

  if (flags["cron"] !== undefined) {
    if (!validateCron(flags["cron"])) {
      fail(`Invalid cron expression: "${flags["cron"]}".`);
    }
    schedule.cronExpression = flags["cron"];
  }

  saveStore(store);
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
}

main();
