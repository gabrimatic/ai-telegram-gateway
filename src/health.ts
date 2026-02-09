import { getConfig } from "./config";
import { info, warn, error, debug } from "./logger";
import { isSessionAlive, restartSession, getCurrentModel, getStats as getAIStats } from "./ai";
import { getMetrics, shouldResetSession, resetMetrics, formatMetrics } from "./metrics";
import { triggerDailyReset } from "./scheduler";
import { isWhisperKitRunning, startWhisperKitServer } from "./service-manager";
import { checkResources } from "./resource-monitor";
import type { ResourceCheckResult } from "./resource-monitor";
import { sendAdminAlert } from "./alerting";
import { getProviderDisplayName } from "./provider";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { env } from "./env";

export interface HealthStats {
  startedAt: Date;
  messagesProcessed: number;
  errorsCount: number;
  lastMessageAt: Date | null;
  sessionRestarts: number;
  memoryResets: number;
  uptimeSeconds: number;
}

const stats: HealthStats = {
  startedAt: new Date(),
  messagesProcessed: 0,
  errorsCount: 0,
  lastMessageAt: null,
  sessionRestarts: 0,
  memoryResets: 0,
  uptimeSeconds: 0,
};

let healthInterval: NodeJS.Timeout | null = null;
let statsLogInterval: NodeJS.Timeout | null = null;
let consecutiveHealthFailures = 0;
const MAX_CONSECUTIVE_HEALTH_FAILURES = 3;
let healthDirEnsured = false;

function ensureHealthFileDir(): void {
  if (healthDirEnsured) {
    return;
  }
  const healthDir = dirname(env.TG_HEALTH_FILE);
  if (!existsSync(healthDir)) {
    mkdirSync(healthDir, { recursive: true });
  }
  healthDirEnsured = true;
}

function writeHealthFile(resourceStatus: ResourceCheckResult | null): void {
  try {
    ensureHealthFileDir();
    const payload = {
      timestamp: new Date().toISOString(),
      health: {
        startedAt: stats.startedAt.toISOString(),
        messagesProcessed: stats.messagesProcessed,
        errorsCount: stats.errorsCount,
        lastMessageAt: stats.lastMessageAt?.toISOString() || null,
        sessionRestarts: stats.sessionRestarts,
        memoryResets: stats.memoryResets,
        uptimeSeconds: stats.uptimeSeconds,
      },
      resources: resourceStatus
        ? {
            status: resourceStatus.status,
            memory: {
              percentUsed: Number(resourceStatus.memory.percentUsed.toFixed(2)),
              heapUsed: resourceStatus.memory.heapUsed,
              heapTotal: resourceStatus.memory.heapTotal,
              rss: resourceStatus.memory.rss,
            },
            disk: resourceStatus.disk
              ? {
                  percentUsed: Number(resourceStatus.disk.percentUsed.toFixed(2)),
                  total: resourceStatus.disk.total,
                  used: resourceStatus.disk.used,
                  available: resourceStatus.disk.available,
                }
              : null,
            warnings: resourceStatus.warnings,
          }
        : null,
    };

    writeFileSync(env.TG_HEALTH_FILE, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    error("health", "health_file_write_failed", {
      file: env.TG_HEALTH_FILE,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function checkHealth(): Promise<void> {
  debug("health", "checking");

  const config = getConfig();
  const providerName = getProviderDisplayName();
  let resourceStatus: ResourceCheckResult | null = null;

  // Check system resources
  try {
    resourceStatus = await checkResources();
    debug("health", "resource_status", {
      status: resourceStatus.status,
      memoryPercent: resourceStatus.memory.percentUsed,
      diskPercent: resourceStatus.disk?.percentUsed ?? null,
    });

    // Alert on critical resource issues
    for (const warning of resourceStatus.warnings) {
      if (warning.status === "critical") {
        if (warning.resource === "disk") {
          await sendAdminAlert(warning.message, "critical", "disk_low");
        } else if (warning.resource === "memory") {
          await sendAdminAlert(warning.message, "critical", "memory_critical");
        }
      }
    }
  } catch (err) {
    error("health", "resource_check_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Check if AI session is alive
  if (!isSessionAlive()) {
    consecutiveHealthFailures++;
    warn("health", "session_not_alive_restarting", { consecutiveFailures: consecutiveHealthFailures });
    try {
      await restartSession();
      stats.sessionRestarts++;
      consecutiveHealthFailures = 0;
      info("health", "session_restarted", { totalRestarts: stats.sessionRestarts });
    } catch (err) {
      error("health", "session_restart_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (consecutiveHealthFailures >= MAX_CONSECUTIVE_HEALTH_FAILURES) {
        await sendAdminAlert(
          `${providerName} restart failed ${consecutiveHealthFailures} times consecutively`,
          "critical",
          "consecutive_failures"
        );
      }
    }
  } else {
    consecutiveHealthFailures = 0;
  }

  // Check WhisperKit for voice transcription
  const whisperKitRunning = await isWhisperKitRunning();
  if (!whisperKitRunning) {
    warn("health", "whisperkit_down_attempting_restart");
    try {
      const restarted = await startWhisperKitServer();
      if (restarted) {
        info("health", "whisperkit_restarted");
      } else {
        error("health", "whisperkit_restart_failed");
      }
    } catch (err) {
      error("health", "whisperkit_restart_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Check if session should be reset due to low quality
  if (shouldResetSession()) {
    warn("health", "quality_degraded_resetting", { metrics: getMetrics() });
    try {
      await restartSession();
      resetMetrics();
      stats.sessionRestarts++;
      stats.memoryResets++;
      info("health", "quality_reset_complete");
    } catch (err) {
      error("health", "quality_reset_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Check if session exceeds configured age limit
  const aiStats = getAIStats();
  if (aiStats && config.sessionResetIntervalHours > 0) {
    const maxAgeSeconds = config.sessionResetIntervalHours * 3600;
    if (aiStats.durationSeconds >= maxAgeSeconds) {
      info("health", "session_age_reset", {
        sessionAgeSeconds: aiStats.durationSeconds,
        maxAgeSeconds,
      });
      try {
        await triggerDailyReset();
        stats.memoryResets++;
        info("health", "session_age_reset_complete");
      } catch (err) {
        error("health", "session_age_reset_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Update uptime
  stats.uptimeSeconds = Math.floor((Date.now() - stats.startedAt.getTime()) / 1000);
  writeHealthFile(resourceStatus);
}

function logStats(): void {
  info("health", "stats", {
    uptimeSeconds: stats.uptimeSeconds,
    messagesProcessed: stats.messagesProcessed,
    errorsCount: stats.errorsCount,
    sessionRestarts: stats.sessionRestarts,
    memoryResets: stats.memoryResets,
    lastMessageAt: stats.lastMessageAt?.toISOString() || null,
  });
}

export function startHealthMonitor(): void {
  const config = getConfig();

  // Reset stats
  stats.startedAt = new Date();
  stats.messagesProcessed = 0;
  stats.errorsCount = 0;
  stats.lastMessageAt = null;
  stats.sessionRestarts = 0;
  stats.memoryResets = 0;
  stats.uptimeSeconds = 0;

  // Health check interval
  healthInterval = setInterval(checkHealth, config.healthCheckIntervalMs);

  // Log stats every hour
  statsLogInterval = setInterval(logStats, 60 * 60 * 1000);

  info("health", "monitor_started", {
    checkIntervalMs: config.healthCheckIntervalMs,
  });
}

export function stopHealthMonitor(): void {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
  if (statsLogInterval) {
    clearInterval(statsLogInterval);
    statsLogInterval = null;
  }
  info("health", "monitor_stopped");
}

export function incrementMessages(): void {
  stats.messagesProcessed++;
  stats.lastMessageAt = new Date();
}

export function incrementErrors(): void {
  stats.errorsCount++;
}

export function incrementSessionRestarts(): void {
  stats.sessionRestarts++;
}

export function incrementMemoryResets(): void {
  stats.memoryResets++;
}

export function getStats(): HealthStats {
  stats.uptimeSeconds = Math.floor((Date.now() - stats.startedAt.getTime()) / 1000);
  return { ...stats };
}

export function getStartTime(): Date {
  return stats.startedAt;
}

export function formatStats(): string {
  const s = getStats();
  const uptime = formatUptime(s.uptimeSeconds);
  const lastMsg = s.lastMessageAt
    ? formatTimeAgo(s.lastMessageAt)
    : "never";
  const model = getCurrentModel();
  const providerName = getProviderDisplayName();

  const basicStats = [
    `Model: ${model}`,
    `Uptime: ${uptime}`,
    `Messages: ${s.messagesProcessed}`,
    `Errors: ${s.errorsCount}`,
    `Last message: ${lastMsg}`,
    `${providerName} restarts: ${s.sessionRestarts}`,
    `Memory resets: ${s.memoryResets}`,
  ].join("\n");

  return `${basicStats}\n\n${formatMetrics()}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);

  return parts.join(" ");
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
