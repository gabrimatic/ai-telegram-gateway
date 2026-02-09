/**
 * Self-healing capabilities for the Telegram Gateway bot
 * Detects and auto-recovers from: stuck sessions, memory pressure,
 * disk space issues, process zombies, and repeated error patterns.
 */

import { execSync } from "child_process";
import { existsSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { info, warn, error as logError, debug } from "./logger";
import { restartSession, isSessionAlive } from "./ai";
import { getMemoryUsage, getDiskUsage } from "./resource-monitor";
import { getConfig } from "./config";
import { sendAdminAlert, AlertCategory } from "./alerting";
import { trackError } from "./analytics";

// Error tracking for pattern detection
interface ErrorOccurrence {
  type: string;
  timestamp: number;
  message: string;
}

const recentErrors: ErrorOccurrence[] = [];
const MAX_ERROR_HISTORY = 100;
const ERROR_PATTERN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const ERROR_PATTERN_THRESHOLD = 3; // 3+ of same type in window

// Recovery action log
interface RecoveryAction {
  timestamp: number;
  trigger: string;
  action: string;
  success: boolean;
  details?: string;
}

const recoveryLog: RecoveryAction[] = [];
const MAX_RECOVERY_LOG = 50;

// Cooldown to prevent recovery loops
const recoveryCooldowns: Map<string, number> = new Map();
const RECOVERY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between same recovery type

function isOnCooldown(recoveryType: string): boolean {
  const lastRun = recoveryCooldowns.get(recoveryType);
  if (!lastRun) return false;
  return Date.now() - lastRun < RECOVERY_COOLDOWN_MS;
}

function setCooldown(recoveryType: string): void {
  recoveryCooldowns.set(recoveryType, Date.now());
}

function logRecovery(trigger: string, action: string, success: boolean, details?: string): void {
  const entry: RecoveryAction = {
    timestamp: Date.now(),
    trigger,
    action,
    success,
    details,
  };
  recoveryLog.push(entry);
  if (recoveryLog.length > MAX_RECOVERY_LOG) {
    recoveryLog.shift();
  }

  if (success) {
    info("self-heal", "recovery_action", { trigger, action, details });
  } else {
    logError("self-heal", "recovery_failed", { trigger, action, details });
  }
}

// --- Error pattern detection ---

export function recordError(errorType: string, message: string): void {
  recentErrors.push({
    type: errorType,
    timestamp: Date.now(),
    message,
  });

  // Trim old entries
  if (recentErrors.length > MAX_ERROR_HISTORY) {
    recentErrors.splice(0, recentErrors.length - MAX_ERROR_HISTORY);
  }

  // Track in analytics too
  trackError(errorType);

  // Check for patterns
  checkErrorPatterns(errorType);
}

function checkErrorPatterns(latestType: string): void {
  const now = Date.now();
  const windowStart = now - ERROR_PATTERN_WINDOW_MS;

  // Count occurrences of the latest error type within the window
  const count = recentErrors.filter(
    (e) => e.type === latestType && e.timestamp >= windowStart
  ).length;

  if (count >= ERROR_PATTERN_THRESHOLD) {
    warn("self-heal", "error_pattern_detected", {
      errorType: latestType,
      count,
      windowMinutes: ERROR_PATTERN_WINDOW_MS / 60000,
    });

    // Trigger recovery based on error type
    triggerPatternRecovery(latestType, count).catch((err) => {
      logError("self-heal", "pattern_recovery_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

async function triggerPatternRecovery(errorType: string, count: number): Promise<void> {
  const recoveryKey = `pattern_${errorType}`;

  if (isOnCooldown(recoveryKey)) {
    debug("self-heal", "pattern_recovery_on_cooldown", { errorType });
    return;
  }
  setCooldown(recoveryKey);

  switch (errorType) {
    case "timeout":
    case "process_crash":
    case "unknown":
      // Restart the AI session
      await recoverSession(`repeated ${errorType} (${count}x in 10min)`);
      break;

    case "mcp_tool_failure":
      // Log and alert, but MCP issues need manual intervention
      await sendAdminAlert(
        `Repeated MCP tool failures: ${count}x in 10 minutes. Check MCP services.`,
        "warning",
        "consecutive_failures" as AlertCategory
      );
      logRecovery(`repeated_${errorType}`, "admin_alert_sent", true);
      break;

    default:
      // For other patterns, restart session as a catch-all
      await recoverSession(`repeated ${errorType} (${count}x in 10min)`);
      break;
  }
}

// --- Session recovery ---

async function recoverSession(reason: string): Promise<void> {
  if (isOnCooldown("session_restart")) {
    debug("self-heal", "session_restart_on_cooldown");
    return;
  }
  setCooldown("session_restart");

  try {
    info("self-heal", "restarting_session", { reason });
    await restartSession();
    logRecovery(reason, "session_restart", true);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logRecovery(reason, "session_restart", false, errMsg);
  }
}

// --- Memory pressure recovery ---

export async function checkAndRecoverMemory(): Promise<boolean> {
  if (isOnCooldown("memory_recovery")) return false;

  const config = getConfig();
  const mem = getMemoryUsage();

  if (mem.percentUsed < config.resources.memoryCriticalPercent) {
    return false;
  }

  setCooldown("memory_recovery");
  warn("self-heal", "memory_pressure_detected", { percentUsed: mem.percentUsed });

  // Step 1: Force garbage collection if available
  if (global.gc) {
    try {
      global.gc();
      logRecovery("memory_pressure", "forced_gc", true, `${mem.percentUsed.toFixed(1)}% used`);

      // Check if GC helped
      const afterGc = getMemoryUsage();
      if (afterGc.percentUsed < config.resources.memoryCriticalPercent) {
        info("self-heal", "gc_resolved_pressure", { before: mem.percentUsed, after: afterGc.percentUsed });
        return true;
      }
    } catch (err) {
      logRecovery("memory_pressure", "forced_gc", false, String(err));
    }
  }

  // Step 2: Restart session to free up child process memory
  try {
    await restartSession();
    logRecovery("memory_pressure", "session_restart", true, `${mem.percentUsed.toFixed(1)}% used`);
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logRecovery("memory_pressure", "session_restart", false, errMsg);
    return false;
  }
}

// --- Disk space recovery ---

export async function checkAndRecoverDisk(): Promise<boolean> {
  if (isOnCooldown("disk_recovery")) return false;

  const disk = await getDiskUsage("/");
  if (!disk || disk.percentUsed < 90) {
    return false;
  }

  setCooldown("disk_recovery");
  warn("self-heal", "disk_pressure_detected", { percentUsed: disk.percentUsed });

  let cleaned = false;

  // Clean temp files
  const tempDirs = [
    join(homedir(), ".claude", "gateway", "files"),
    "/tmp",
  ];

  for (const dir of tempDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir);
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 1 day

      for (const file of files) {
        const fullPath = join(dir, file);
        try {
          const stat = statSync(fullPath);
          if (now - stat.mtimeMs > maxAge && stat.isFile()) {
            unlinkSync(fullPath);
            cleaned = true;
          }
        } catch {
          // Skip files we can't stat/delete
        }
      }
    } catch {
      // Skip dirs we can't read
    }
  }

  // Clean old log files (older than 3 days under pressure)
  try {
    const logDir = join(homedir(), ".claude", "logs", "telegram-gateway");
    if (existsSync(logDir)) {
      const files = readdirSync(logDir);
      const now = Date.now();
      const maxAge = 3 * 24 * 60 * 60 * 1000; // 3 days under pressure

      for (const file of files) {
        const fullPath = join(logDir, file);
        try {
          const stat = statSync(fullPath);
          if (now - stat.mtimeMs > maxAge && stat.isFile()) {
            unlinkSync(fullPath);
            cleaned = true;
          }
        } catch {
          // Skip
        }
      }
    }
  } catch {
    // Skip
  }

  logRecovery("disk_pressure", "clean_temp_and_logs", cleaned, `${disk.percentUsed.toFixed(1)}% used`);
  return cleaned;
}

// --- Zombie process cleanup ---

export function cleanZombieProcesses(): boolean {
  if (isOnCooldown("zombie_cleanup")) return false;

  try {
    // Find zombie claude/node processes that belong to us
    const result = execSync(
      "ps aux | grep -E '(claude|node)' | grep -v grep | grep -v 'self-heal' 2>/dev/null || true",
      { encoding: "utf-8", timeout: 5000 }
    );

    // Look for processes consuming excessive CPU or memory
    const lines = result.split("\n").filter((l) => l.trim());
    let killed = 0;

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 11) continue;

      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      const pid = parseInt(parts[1], 10);

      // Skip our own process
      if (pid === process.pid) continue;

      // Kill if using >90% CPU for sustained period or >50% memory
      if (cpu > 90 || mem > 50) {
        // Only kill claude processes, not arbitrary node processes
        if (line.includes("claude") && !line.includes("telegram-gateway")) {
          try {
            process.kill(pid, "SIGTERM");
            killed++;
            debug("self-heal", "killed_zombie", { pid, cpu, mem });
          } catch {
            // Process may have already exited
          }
        }
      }
    }

    if (killed > 0) {
      setCooldown("zombie_cleanup");
      logRecovery("zombie_processes", "kill_zombies", true, `killed ${killed} processes`);
      return true;
    }

    return false;
  } catch (err) {
    debug("self-heal", "zombie_check_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// --- Stuck session recovery (extends existing) ---

export async function checkAndRecoverStuckSession(): Promise<boolean> {
  if (isOnCooldown("stuck_session")) return false;

  if (!isSessionAlive()) {
    setCooldown("stuck_session");
    await recoverSession("session_not_alive");
    return true;
  }

  return false;
}

// --- Run all self-healing checks ---

export async function runSelfHealingChecks(): Promise<void> {
  debug("self-heal", "running_checks");

  try {
    await checkAndRecoverStuckSession();
    await checkAndRecoverMemory();
    await checkAndRecoverDisk();
    cleanZombieProcesses();
  } catch (err) {
    logError("self-heal", "check_cycle_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Query functions ---

export function getRecoveryLog(): RecoveryAction[] {
  return [...recoveryLog];
}

export function getRecentErrorPatterns(): { type: string; count: number; lastSeen: number }[] {
  const now = Date.now();
  const windowStart = now - ERROR_PATTERN_WINDOW_MS;
  const filtered = recentErrors.filter((e) => e.timestamp >= windowStart);

  const counts: Map<string, { count: number; lastSeen: number }> = new Map();
  for (const e of filtered) {
    const existing = counts.get(e.type);
    if (existing) {
      existing.count++;
      existing.lastSeen = Math.max(existing.lastSeen, e.timestamp);
    } else {
      counts.set(e.type, { count: 1, lastSeen: e.timestamp });
    }
  }

  return Array.from(counts.entries())
    .map(([type, data]) => ({ type, ...data }))
    .sort((a, b) => b.count - a.count);
}

export function formatRecoveryLog(): string {
  if (recoveryLog.length === 0) {
    return "No recovery actions recorded.";
  }

  const lines: string[] = ["Recent recovery actions:"];
  const recent = recoveryLog.slice(-10).reverse();

  for (const entry of recent) {
    const time = new Date(entry.timestamp).toLocaleTimeString("en-GB", { timeZone: "Europe/Berlin" });
    const status = entry.success ? "OK" : "FAIL";
    lines.push(`  [${time}] [${status}] ${entry.trigger} -> ${entry.action}${entry.details ? ` (${entry.details})` : ""}`);
  }

  return lines.join("\n");
}

export function formatErrorPatterns(): string {
  const patterns = getRecentErrorPatterns();

  if (patterns.length === 0) {
    return "No error patterns in the last 10 minutes.";
  }

  const lines: string[] = ["Error patterns (last 10 min):"];
  for (const p of patterns) {
    const ago = Math.round((Date.now() - p.lastSeen) / 1000);
    lines.push(`  ${p.type}: ${p.count}x (last seen ${ago}s ago)`);
  }

  return lines.join("\n");
}
