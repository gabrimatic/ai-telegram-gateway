import { getConfig } from "./config";
import { info, error, debug } from "./logger";
import { saveSessionSummary } from "./memory";
import { restartSession, hasProcessedMessages } from "./ai";
import { incrementMemoryResets } from "./health";
import { cleanupOldFiles } from "./files";

type ScheduledTask = {
  name: string;
  hour: number;
  minute: number;
  handler: () => Promise<void>;
  lastRun?: string;
};

const tasks: ScheduledTask[] = [];
let checkInterval: NodeJS.Timeout | null = null;
let fileCleanupInterval: NodeJS.Timeout | null = null;

// File cleanup runs every 30 minutes
const FILE_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

function getDateKey(): string {
  return new Date().toISOString().split("T")[0];
}

function getCurrentTime(): { hour: number; minute: number } {
  const now = new Date();
  return {
    hour: now.getHours(),
    minute: now.getMinutes(),
  };
}

async function dailyReset(): Promise<void> {
  info("scheduler", "daily_reset_starting");

  try {
    // Only save summary if we've processed messages
    if (hasProcessedMessages()) {
      info("scheduler", "saving_session_summary");
      const saved = await saveSessionSummary();
      if (saved) {
        incrementMemoryResets();
      }
    } else {
      debug("scheduler", "no_messages_processed_skipping_summary");
    }

    // Restart AI session
    info("scheduler", "restarting_session");
    await restartSession();

    info("scheduler", "daily_reset_complete");
  } catch (err) {
    error("scheduler", "daily_reset_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function checkTasks(): void {
  const { hour, minute } = getCurrentTime();
  const dateKey = getDateKey();

  for (const task of tasks) {
    // Check if it's time and hasn't run today
    if (task.hour === hour && minute >= task.minute && task.lastRun !== dateKey) {
      task.lastRun = dateKey;
      debug("scheduler", "running_task", { name: task.name });
      task.handler().catch((err) => {
        error("scheduler", "task_failed", {
          name: task.name,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}

export function startScheduler(): void {
  const config = getConfig();

  // Register daily reset task
  tasks.push({
    name: "daily_reset",
    hour: config.dailyResetHour,
    minute: 0,
    handler: dailyReset,
  });

  info("scheduler", "started", {
    dailyResetHour: config.dailyResetHour,
    taskCount: tasks.length,
  });

  // Check every minute
  checkInterval = setInterval(checkTasks, 60000);

  // Also check immediately in case we started right at the scheduled time
  checkTasks();

  // Start file cleanup interval (every 30 minutes)
  fileCleanupInterval = setInterval(() => {
    debug("scheduler", "running_file_cleanup");
    cleanupOldFiles();
  }, FILE_CLEANUP_INTERVAL_MS);

  // Run cleanup immediately on start
  cleanupOldFiles();
}

export function stopScheduler(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  if (fileCleanupInterval) {
    clearInterval(fileCleanupInterval);
    fileCleanupInterval = null;
  }
  // Clear tasks array to prevent duplicates on restart
  tasks.length = 0;
  info("scheduler", "stopped");
}

export function addScheduledTask(
  name: string,
  hour: number,
  minute: number,
  handler: () => Promise<void>
): void {
  tasks.push({ name, hour, minute, handler });
  debug("scheduler", "task_added", { name, hour, minute });
}

export function triggerDailyReset(): Promise<void> {
  return dailyReset();
}
