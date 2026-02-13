import "dotenv/config";
import { execSync } from "child_process";
import * as fs from "fs";
import { env } from "./env";
import { loadConfig, getConfigPath } from "./config";
import { initLogger, info, warn, error, getLogDir, startLogMaintenance, stopLogMaintenance } from "./logger";
import { startHealthMonitor, stopHealthMonitor, getStats, formatStats } from "./health";
import { startScheduler, stopScheduler, triggerDailyReset } from "./scheduler";
import { saveSessionSummary } from "./memory";
import { stopSession, hasProcessedMessages } from "./ai";
import { createBot, startPolling } from "./poller";
import {
  startServices,
  stopServices,
  startServiceHealthMonitor,
  stopServiceHealthMonitor,
} from "./service-manager";
import { setBotInstance } from "./alerting";
import { getConfiguredProviderName, getProviderProcessConfig } from "./provider";
import { initTaskScheduler, stopTaskScheduler, setTaskNotifier, reloadSchedules, setTaskTelegramApiContextProvider } from "./task-scheduler";
import { initAnalytics, stopAnalytics } from "./analytics";
import { startWatchdog, stopWatchdog } from "./watchdog";
import { initSentinel, stopSentinel } from "./sentinel";
import { checkPostDeployHealth, checkRollbackNeeded } from "./deployer";
import { checkAuthStatus, enterDegradedMode, startPeriodicAuthCheck, stopPeriodicAuthCheck } from "./ai/auth-check";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const PID_FILE = env.TG_PID_FILE;

/**
 * Check if a process with the given PID is running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process, first with SIGTERM, then SIGKILL after 1 second if still running.
 */
function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[startup] Sent SIGTERM to process: ${pid}`);

    // Wait 1 second, then check if still running
    setTimeout(() => {
      if (isProcessRunning(pid)) {
        try {
          process.kill(pid, "SIGKILL");
          console.log(`[startup] Sent SIGKILL to process: ${pid}`);
        } catch {
          // Process may have exited
        }
      }
    }, 1000);
  } catch {
    // Process may have already exited
  }
}

/**
 * Enforce single instance using PID file.
 * - Check if PID file exists
 * - If exists and process running, kill it
 * - Write current PID to file
 */
async function enforceSingleInstance(): Promise<void> {
  const myPid = process.pid;

  // Check existing PID file
  if (fs.existsSync(PID_FILE)) {
    try {
      const existingPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);

      if (!isNaN(existingPid) && existingPid !== myPid && isProcessRunning(existingPid)) {
        console.log(`[startup] Found running gateway process: ${existingPid}`);
        killProcess(existingPid);
        // Give it time to terminate (non-blocking)
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    } catch {
      // Error reading PID file - continue
    }
  }

  // Write current PID
  fs.writeFileSync(PID_FILE, String(myPid), "utf-8");
  console.log(`[startup] Wrote PID file: ${PID_FILE} (${myPid})`);
}

/**
 * Delete the PID file on shutdown.
 */
function cleanupPidFile(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
      console.log(`[shutdown] Removed PID file: ${PID_FILE}`);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Kill orphaned provider processes spawned by the gateway.
 */
function cleanupOrphanedProviderProcesses(providerName: string, mcpConfigPath: string): void {
  const providerConfig = getProviderProcessConfig(providerName, { mcpConfigPath });
  if (!providerConfig.orphanedProcessPattern) {
    return;
  }

  try {
    const providerProcs = execSync(
      `pgrep -f "${providerConfig.orphanedProcessPattern}" 2>/dev/null || true`,
      { encoding: "utf-8" }
    ).trim();

    if (providerProcs) {
      const pids = providerProcs.split("\n").filter((p) => p);
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid), "SIGKILL");
          console.log(`[startup] Killed orphaned provider process: ${pid}`);
        } catch {
          // Process may have already exited
        }
      }
    }
  } catch {
    // pgrep not found or no matches - safe to ignore
  }
}

async function main(): Promise<void> {
  // Enforce single instance using PID file
  await enforceSingleInstance();

  // Check if a recent deploy is crash-looping and needs rollback
  if (await checkRollbackNeeded()) {
    console.log("[startup] Rollback performed. Exiting for PM2 restart with rolled-back code.");
    process.exit(0);
  }

  // Load configuration first
  const config = loadConfig();

  // Kill orphaned provider processes
  cleanupOrphanedProviderProcesses(getConfiguredProviderName(config), config.mcpConfigPath);

  // Initialize logger
  initLogger({
    debug: config.debug,
    logRetentionDays: config.logRetentionDays,
  });
  startLogMaintenance();

  info("daemon", "starting", {
    configPath: getConfigPath(),
    logDir: getLogDir(),
    debug: config.debug,
    dailyResetHour: config.dailyResetHour,
  });

  if (!TELEGRAM_BOT_TOKEN) {
    error("daemon", "missing_token", {
      message: "TELEGRAM_BOT_TOKEN environment variable is not set",
    });
    process.exit(1);
  }

  // Initialize analytics
  initAnalytics();

  // Start health monitor
  startHealthMonitor();

  // Start scheduler for daily reset
  startScheduler();

  // Start voice services (blocking until ready)
  await startServices();
  startServiceHealthMonitor();

  // Proactive auth check - enter degraded mode at startup if CLI is not authenticated.
  // Periodic checks will auto-recover when auth is restored.
  if (!checkAuthStatus()) {
    warn("daemon", "startup_auth_failed");
    enterDegradedMode("CLI not authenticated at startup");
  }
  startPeriodicAuthCheck();

  // Create bot
  const bot = await createBot(TELEGRAM_BOT_TOKEN);

  // Set bot instance for alerting
  setBotInstance(bot);

  // Start watchdog for proactive monitoring
  startWatchdog();

  // Initialize task scheduler and wire up notifications via bot
  const botMe = bot.botInfo ?? await bot.api.getMe();
  setTaskNotifier(async (userId: string, message: string) => {
    try {
      await bot.api.sendMessage(userId, message);
    } catch (err) {
      error("daemon", "task_notify_failed", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  setTaskTelegramApiContextProvider(() => ({
    raw: bot.api.raw,
    getMe: () => bot.api.getMe(),
    getChat: (chatId: number | string) => bot.api.getChat(chatId),
    getChatMember: (chatId: number | string, userId: number) => bot.api.getChatMember(chatId, userId),
    botId: botMe.id,
  }));
  initTaskScheduler();

  // Initialize sentinel (proactive monitoring)
  const sentinelNotifier = async (userId: string, message: string) => {
    try {
      await bot.api.sendMessage(userId, message, { parse_mode: "HTML" });
    } catch (err) {
      error("daemon", "sentinel_notify_failed", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  initSentinel(sentinelNotifier);

  // Handle graceful shutdown
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    info("daemon", "shutdown_starting", { signal });

    // Save session memory if we've processed messages
    if (hasProcessedMessages()) {
      info("daemon", "saving_final_session");
      try {
        await saveSessionSummary();
      } catch (err) {
        error("daemon", "final_session_save_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Stop all components
    stopPeriodicAuthCheck();
    stopSentinel();
    stopWatchdog();
    stopTaskScheduler();
    stopScheduler();
    stopHealthMonitor();
    stopAnalytics();
    stopLogMaintenance();
    stopSession();
    stopServiceHealthMonitor();
    stopServices();
    bot.stop();

    // Clean up PID file
    cleanupPidFile();

    info("daemon", "shutdown_complete");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((err) => {
      error("daemon", "shutdown_error", { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((err) => {
      error("daemon", "shutdown_error", { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
  });

  process.on("SIGUSR2", () => {
    info("daemon", "sigusr2_reload");
    reloadSchedules();
  });

  // Handle uncaught errors
  process.on("uncaughtException", (err) => {
    error("daemon", "uncaught_exception", {
      error: err.message,
      stack: err.stack?.split("\n").slice(0, 10).join("\n"),
    });
    // Clean up PID file before exit
    cleanupPidFile();
    // Allow log flush, then exit so PM2 can restart
    setTimeout(() => process.exit(1), 200);
  });

  process.on("unhandledRejection", (reason) => {
    error("daemon", "unhandled_rejection", {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack?.split("\n").slice(0, 5).join("\n") : undefined,
    });
    // Don't exit on unhandled rejections - just log them
    // The specific subsystems have their own error recovery
  });

  try {
    await startPolling(bot);

    // Mark deploy as successful if we just deployed
    checkPostDeployHealth();
  } catch (err) {
    error("daemon", "fatal_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

// Export for command handling
export { getStats, formatStats, triggerDailyReset };

main();
