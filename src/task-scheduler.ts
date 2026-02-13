/**
 * Task Scheduler - schedule one-time or recurring tasks that spawn Claude CLI instances.
 * Persists schedules to ~/.claude/gateway/schedules.json.
 * Uses node-cron for cron-based scheduling.
 */

import { spawn, exec, execFile } from "child_process";
import * as readline from "readline";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
} from "fs";
import { dirname, join, extname } from "path";
import { homedir } from "os";
import * as cron from "node-cron";
import { env } from "./env";
import { getConfig } from "./config";
import { info, warn, error as logError, debug } from "./logger";

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
const MAX_HISTORY_PER_SCHEDULE = 50;
const TASK_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes per task execution
const TIMEZONE = "Europe/Berlin";

// --- State ---

// Active cron jobs keyed by schedule ID
const activeCronJobs: Map<number, cron.ScheduledTask> = new Map();
// Active one-time timers keyed by schedule ID
const activeTimers: Map<number, NodeJS.Timeout> = new Map();
// Notification callback - set by the bot integration
let notifyUser: ((userId: string, message: string) => Promise<void>) | null = null;

// --- Storage ---

function ensureStorageDir(): void {
  if (!existsSync(SCHEDULES_DIR)) {
    mkdirSync(SCHEDULES_DIR, { recursive: true });
  }
}

function atomicWriteSync(filePath: string, content: string): void {
  const tempPath = join(dirname(filePath), `.${Date.now()}.tmp`);
  writeFileSync(tempPath, content);
  renameSync(tempPath, filePath);
}

export function loadSchedules(): ScheduleStore {
  ensureStorageDir();
  if (!existsSync(SCHEDULES_PATH)) {
    return { schedules: [], nextId: 1 };
  }
  try {
    return JSON.parse(readFileSync(SCHEDULES_PATH, "utf-8")) as ScheduleStore;
  } catch {
    return { schedules: [], nextId: 1 };
  }
}

export function saveSchedules(store: ScheduleStore): void {
  ensureStorageDir();
  atomicWriteSync(SCHEDULES_PATH, JSON.stringify(store, null, 2));
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

// --- Output routing ---

/**
 * Route task output based on schedule.output setting.
 */
async function routeOutput(
  schedule: Schedule,
  taskOutput: string,
  success: boolean,
  durationMs: number
): Promise<void> {
  const outputTarget = schedule.output ?? "telegram";
  const statusIcon = success ? "\u2705" : "\u274C";
  const truncatedOutput = taskOutput.length > 1500
    ? taskOutput.substring(0, 1500) + "... (truncated)"
    : taskOutput;
  const displayName = schedule.name ? ` (${schedule.name})` : "";
  const message = `${statusIcon} Task #${schedule.id}${displayName} ${success ? "completed" : "failed"} (${(durationMs / 1000).toFixed(1)}s):\n\n${truncatedOutput}`;

  if (outputTarget === "telegram") {
    if (notifyUser) {
      await notifyUser(schedule.userId, message).catch(() => {});
    }
  } else if (outputTarget === "silent") {
    // Log only, no notification
    debug("task-scheduler", "silent_output", { id: schedule.id, success });
  } else if (outputTarget.startsWith("file:")) {
    const filePath = outputTarget.slice(5);
    try {
      appendFileSync(filePath, `[${new Date().toISOString()}] Task #${schedule.id}${displayName} (${success ? "ok" : "fail"}):\n${taskOutput}\n\n`);
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
    const body = `${success ? "Success" : "Failed"} (${(durationMs / 1000).toFixed(1)}s)\n\n${taskOutput}`;
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
  const startTime = Date.now();
  const outputTarget = schedule.output ?? "telegram";
  const displayName = schedule.name ? ` (${schedule.name})` : "";

  info("task-scheduler", "task_starting", {
    id: schedule.id,
    jobType: schedule.jobType ?? "prompt",
    task: schedule.task.substring(0, 80),
  });

  // Notify user that task is starting (unless silent)
  if (notifyUser && outputTarget !== "silent") {
    await notifyUser(
      schedule.userId,
      `\u23F3 Scheduled task #${schedule.id}${displayName} starting: ${schedule.task}`
    ).catch(() => {});
  }

  try {
    // Dispatch based on jobType
    let result: { output: string; success: boolean };
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
        result = await executeClaudeTask(schedule.task);
        break;
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

    const store = loadSchedules();
    const stored = store.schedules.find((s) => s.id === schedule.id);
    if (stored) {
      stored.history.push(entry);
      // Cap history
      if (stored.history.length > MAX_HISTORY_PER_SCHEDULE) {
        stored.history = stored.history.slice(-MAX_HISTORY_PER_SCHEDULE);
      }
      stored.lastRun = entry.timestamp;

      // For one-time schedules, mark completed
      if (stored.type === "once") {
        stored.status = "completed";
        stored.nextRun = undefined;
      }

      saveSchedules(store);
    }

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

    // Record failure in history
    const store = loadSchedules();
    const stored = store.schedules.find((s) => s.id === schedule.id);
    if (stored) {
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
        stored.status = "failed";
        stored.nextRun = undefined;
      }
      saveSchedules(store);
    }

    if (notifyUser) {
      await notifyUser(
        schedule.userId,
        `\u274C Task #${schedule.id}${displayName} failed: ${errorMsg}`
      ).catch(() => {});
    }
  }
}

// --- Scheduling logic ---

function scheduleCronTask(schedule: Schedule): void {
  if (!schedule.cronExpression) return;

  if (!cron.validate(schedule.cronExpression)) {
    logError("task-scheduler", "invalid_cron", {
      id: schedule.id,
      cron: schedule.cronExpression,
    });
    return;
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
      const store = loadSchedules();
      const stored = store.schedules.find((s) => s.id === schedule.id);
      if (stored) {
        stored.nextRun = nextRun.toISOString();
        saveSchedules(store);
      }
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
  if (!schedule.scheduledTime) return;

  const targetTime = new Date(schedule.scheduledTime).getTime();
  const now = Date.now();
  const delay = targetTime - now;

  if (delay <= 0) {
    // Time has passed, run immediately
    info("task-scheduler", "running_overdue_task", { id: schedule.id });
    runScheduledTask(schedule).catch((err) => {
      logError("task-scheduler", "overdue_task_error", {
        id: schedule.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return;
  }

  const timer = setTimeout(() => {
    activeTimers.delete(schedule.id);
    runScheduledTask(schedule).catch((err) => {
      logError("task-scheduler", "once_task_error", {
        id: schedule.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, delay);

  // Don't prevent process exit
  timer.unref();
  activeTimers.set(schedule.id, timer);

  info("task-scheduler", "once_scheduled", {
    id: schedule.id,
    scheduledTime: schedule.scheduledTime,
    delayMs: delay,
  });
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

/**
 * Cancel a schedule by ID.
 */
export function cancelSchedule(
  scheduleId: number,
  userId: string
): { success: boolean; message: string } {
  const store = loadSchedules();
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

  // Stop the cron job or timer
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

  schedule.status = "cancelled";
  saveSchedules(store);

  info("task-scheduler", "schedule_cancelled", { id: scheduleId });
  return { success: true, message: `Schedule #${scheduleId} cancelled.` };
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
