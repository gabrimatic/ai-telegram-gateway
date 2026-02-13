/**
 * Proactive monitoring watchdog for the Telegram Gateway bot
 * Runs every 60 seconds, checks system health, and sends Telegram alerts
 * for critical conditions.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { info, warn, error as logError, debug } from "./logger";
import { getMemoryUsage, getDiskUsage } from "./resource-monitor";
import { sendAdminAlert, AlertCategory } from "./alerting";
import { getErrorRate, getDailyAverageErrorRate } from "./analytics";
import { runSelfHealingChecks } from "./self-heal";
import { getConfig } from "./config";
import { checkAuthStatus, isDegradedMode, enterDegradedMode, exitDegradedMode } from "./ai/auth-check";

const execAsync = promisify(exec);

const WATCHDOG_INTERVAL_MS = 60 * 1000; // 60 seconds
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per alert type

let watchdogInterval: NodeJS.Timeout | null = null;

// Alert cooldown tracking (separate from alerting module's throttle)
const alertCooldowns: Map<string, number> = new Map();

function isAlertOnCooldown(alertType: string): boolean {
  const last = alertCooldowns.get(alertType);
  if (!last) return false;
  return Date.now() - last < ALERT_COOLDOWN_MS;
}

function setAlertCooldown(alertType: string): void {
  alertCooldowns.set(alertType, Date.now());
}

async function alertIfNotCooling(
  alertType: string,
  message: string,
  severity: "info" | "warning" | "critical",
  category: AlertCategory
): Promise<void> {
  if (isAlertOnCooldown(alertType)) {
    debug("watchdog", "alert_on_cooldown", { alertType });
    return;
  }
  setAlertCooldown(alertType);
  await sendAdminAlert(message, severity, category);
}

// --- Individual checks ---

async function checkDiskSpace(): Promise<void> {
  const config = getConfig();
  const disk = await getDiskUsage(config.resources.diskPath);
  if (!disk) return;

  if (disk.percentUsed >= 90) {
    const availGB = (disk.available / (1024 * 1024 * 1024)).toFixed(1);
    await alertIfNotCooling(
      "disk_critical",
      `Disk space critical: ${disk.percentUsed.toFixed(1)}% used (${availGB} GB free)`,
      "critical",
      "disk_low"
    );
  }
}

async function checkMemoryUsage(): Promise<void> {
  const config = getConfig();
  const mem = getMemoryUsage();

  if (mem.percentUsed >= config.resources.memoryCriticalPercent) {
    await alertIfNotCooling(
      "memory_critical",
      `Memory usage critical: ${mem.percentUsed.toFixed(1)}% used`,
      "critical",
      "memory_critical"
    );
  }
}

async function checkCpuLoad(): Promise<void> {
  try {
    const { stdout } = await execAsync("sysctl -n vm.loadavg", { timeout: 5000 });
    // Parse load average - format: "{ 1.23 2.34 3.45 }"
    const match = stdout.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (!match) return;

    const load1m = parseFloat(match[1]);
    // Get number of CPU cores
    const { stdout: coresStr } = await execAsync("sysctl -n hw.ncpu", { timeout: 5000 });
    const cores = parseInt(coresStr.trim(), 10) || 1;

    // Alert if 1-minute load average exceeds 2x cores
    if (load1m > cores * 2) {
      await alertIfNotCooling(
        "cpu_high",
        `CPU load very high: ${load1m.toFixed(2)} (${cores} cores)`,
        "warning",
        "consecutive_failures" as AlertCategory
      );
    }
  } catch (err) {
    debug("watchdog", "cpu_check_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function checkPM2Processes(): Promise<void> {
  try {
    const { stdout } = await execAsync("pm2 jlist 2>/dev/null", { timeout: 10000 });
    const processes = JSON.parse(stdout);

    for (const proc of processes) {
      if (proc.pm2_env?.status === "errored" || proc.pm2_env?.status === "stopped") {
        await alertIfNotCooling(
          `pm2_${proc.name}`,
          `PM2 process "${proc.name}" is ${proc.pm2_env.status}`,
          "critical",
          "service_down"
        );
      }
    }
  } catch {
    // PM2 not available or not running - not necessarily an error
    debug("watchdog", "pm2_check_skipped");
  }
}

async function checkDocker(): Promise<void> {
  try {
    const { stdout } = await execAsync(
      "docker ps --format '{{.Names}}\\t{{.Status}}' 2>/dev/null",
      { timeout: 10000 }
    );

    const lines = stdout.trim().split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const [name, status] = line.split("\t");
      if (status && (status.includes("Exited") || status.includes("Dead"))) {
        await alertIfNotCooling(
          `docker_${name}`,
          `Docker container "${name}" is down: ${status}`,
          "warning",
          "service_down"
        );
      }
    }
  } catch {
    // Docker not available - not necessarily an error on this system
    debug("watchdog", "docker_check_skipped");
  }
}

async function checkNetworkConnectivity(): Promise<void> {
  try {
    // Check if we can reach Telegram API
    await execAsync("curl -s --connect-timeout 5 -o /dev/null -w '%{http_code}' https://api.telegram.org", {
      timeout: 10000,
    });
    // If we get here, connectivity is fine (even error codes mean network works)
  } catch {
    await alertIfNotCooling(
      "network_down",
      "Network connectivity lost: cannot reach Telegram API",
      "critical",
      "service_down"
    );
  }
}

async function checkErrorRateSpike(): Promise<void> {
  const currentRate = getErrorRate(10); // errors per minute over last 10 min
  const avgRate = getDailyAverageErrorRate();

  // Alert if current rate is 3x the daily average and at least 1 error/min
  if (avgRate > 0 && currentRate >= avgRate * 3 && currentRate >= 1) {
    await alertIfNotCooling(
      "error_spike",
      `Error rate spike: ${currentRate.toFixed(1)}/min (avg ${avgRate.toFixed(1)}/min)`,
      "warning",
      "consecutive_failures" as AlertCategory
    );
  }
}

async function checkAuthHealth(): Promise<void> {
  try {
    const isAuthed = checkAuthStatus();

    if (!isAuthed && !isDegradedMode()) {
      enterDegradedMode("Watchdog auth check failed");
      await alertIfNotCooling(
        "auth_expired",
        "CLI authentication expired. Gateway entering degraded mode.",
        "critical",
        "service_down"
      );
    } else if (isAuthed && isDegradedMode()) {
      exitDegradedMode();
      await alertIfNotCooling(
        "auth_restored",
        "CLI authentication restored. Gateway resuming normal operation.",
        "info",
        "service_down"
      );
    }
  } catch (err) {
    debug("watchdog", "auth_check_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Watchdog cycle ---

let watchdogCycleInProgress = false;

async function watchdogCycle(): Promise<void> {
  // Guard against overlapping cycles (previous cycle still running)
  if (watchdogCycleInProgress) {
    debug("watchdog", "cycle_skipped_already_running");
    return;
  }
  watchdogCycleInProgress = true;

  debug("watchdog", "cycle_start");

  try {
    // Run all checks in parallel where possible
    const results = await Promise.allSettled([
      checkDiskSpace(),
      checkMemoryUsage(),
      checkCpuLoad(),
      checkPM2Processes(),
      checkDocker(),
      checkNetworkConnectivity(),
      checkErrorRateSpike(),
      checkAuthHealth(),
    ]);

    // Log any rejected checks for diagnostics
    const checkNames = ["disk", "memory", "cpu", "pm2", "docker", "network", "errorRate", "auth"];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        const reason = (results[i] as PromiseRejectedResult).reason;
        debug("watchdog", "check_failed", {
          check: checkNames[i],
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }

    // Run self-healing checks
    await runSelfHealingChecks();

  } catch (err) {
    logError("watchdog", "cycle_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    watchdogCycleInProgress = false;
  }

  debug("watchdog", "cycle_complete");
}

// --- Lifecycle ---

export function startWatchdog(): void {
  if (watchdogInterval) {
    warn("watchdog", "already_running");
    return;
  }

  watchdogInterval = setInterval(watchdogCycle, WATCHDOG_INTERVAL_MS);
  info("watchdog", "started", { intervalMs: WATCHDOG_INTERVAL_MS });

  // Run first cycle after a short delay (let other systems initialize)
  setTimeout(watchdogCycle, 5000);
}

export function stopWatchdog(): void {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
    info("watchdog", "stopped");
  }
}

export function isWatchdogRunning(): boolean {
  return watchdogInterval !== null;
}

/**
 * Get watchdog status for health dashboard.
 */
export function getWatchdogStatus(): {
  running: boolean;
  alertCooldowns: { type: string; expiresIn: number }[];
} {
  const cooldowns: { type: string; expiresIn: number }[] = [];
  const now = Date.now();

  for (const [type, lastTime] of alertCooldowns.entries()) {
    const remaining = ALERT_COOLDOWN_MS - (now - lastTime);
    if (remaining > 0) {
      cooldowns.push({ type, expiresIn: Math.round(remaining / 1000) });
    }
  }

  return {
    running: watchdogInterval !== null,
    alertCooldowns: cooldowns,
  };
}
