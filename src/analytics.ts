/**
 * Usage analytics for the Telegram Gateway bot
 * Tracks message counts, response times, command usage, peak hours, error rates, etc.
 * Stores daily aggregates in ~/.claude/gateway/analytics/YYYY-MM-DD.json
 * Retains last 30 days of data.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { info, error as logError, debug } from "./logger";

const ANALYTICS_DIR = join(homedir(), ".claude", "gateway", "analytics");
const RETENTION_DAYS = 30;

export interface DailyAnalytics {
  date: string;
  messages: {
    inbound: number;
    outbound: number;
  };
  responseTimes: number[]; // ms values for computing avg/p95/max
  commandUsage: Record<string, number>;
  hourlyActivity: number[]; // 24 slots, index = hour
  errors: {
    total: number;
    byType: Record<string, number>;
    timestamps: number[]; // epoch ms for rate calculation
  };
  sessionDurations: number[]; // seconds
  tokenUsage: {
    estimated: number; // rough char-based estimate
  };
}

function emptyDailyAnalytics(date: string): DailyAnalytics {
  return {
    date,
    messages: { inbound: 0, outbound: 0 },
    responseTimes: [],
    commandUsage: {},
    hourlyActivity: new Array(24).fill(0),
    errors: { total: 0, byType: {}, timestamps: [] },
    sessionDurations: [],
    tokenUsage: { estimated: 0 },
  };
}

function ensureDir(): void {
  if (!existsSync(ANALYTICS_DIR)) {
    mkdirSync(ANALYTICS_DIR, { recursive: true });
  }
}

function todayKey(): string {
  return new Date().toISOString().split("T")[0];
}

function filePath(dateKey: string): string {
  return join(ANALYTICS_DIR, `${dateKey}.json`);
}

function loadDay(dateKey: string): DailyAnalytics {
  const path = filePath(dateKey);
  if (!existsSync(path)) {
    return emptyDailyAnalytics(dateKey);
  }
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as DailyAnalytics;
  } catch {
    return emptyDailyAnalytics(dateKey);
  }
}

function saveDay(data: DailyAnalytics): void {
  ensureDir();
  writeFileSync(filePath(data.date), JSON.stringify(data, null, 2));
}

// Keep response times array from growing unbounded (keep last 500 per day)
const MAX_RESPONSE_TIMES = 500;
const MAX_ERROR_TIMESTAMPS = 500;

function trimArrays(data: DailyAnalytics): void {
  if (data.responseTimes.length > MAX_RESPONSE_TIMES) {
    data.responseTimes = data.responseTimes.slice(-MAX_RESPONSE_TIMES);
  }
  if (data.errors.timestamps.length > MAX_ERROR_TIMESTAMPS) {
    data.errors.timestamps = data.errors.timestamps.slice(-MAX_ERROR_TIMESTAMPS);
  }
}

// --- Public tracking functions ---

export function trackInboundMessage(): void {
  try {
    const data = loadDay(todayKey());
    data.messages.inbound++;
    data.hourlyActivity[new Date().getHours()]++;
    saveDay(data);
  } catch (err) {
    logError("analytics", "track_inbound_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function trackOutboundMessage(responseTimeMs: number, responseLength: number): void {
  try {
    const data = loadDay(todayKey());
    data.messages.outbound++;
    data.responseTimes.push(responseTimeMs);
    // Rough token estimate: ~4 chars per token
    data.tokenUsage.estimated += Math.ceil(responseLength / 4);
    trimArrays(data);
    saveDay(data);
  } catch (err) {
    logError("analytics", "track_outbound_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function trackCommand(command: string): void {
  try {
    const data = loadDay(todayKey());
    data.commandUsage[command] = (data.commandUsage[command] || 0) + 1;
    saveDay(data);
  } catch (err) {
    logError("analytics", "track_command_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function trackError(errorType: string): void {
  try {
    const data = loadDay(todayKey());
    data.errors.total++;
    data.errors.byType[errorType] = (data.errors.byType[errorType] || 0) + 1;
    data.errors.timestamps.push(Date.now());
    trimArrays(data);
    saveDay(data);
  } catch (err) {
    logError("analytics", "track_error_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function trackSessionDuration(durationSeconds: number): void {
  try {
    const data = loadDay(todayKey());
    data.sessionDurations.push(durationSeconds);
    saveDay(data);
  } catch (err) {
    logError("analytics", "track_session_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Query functions ---

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export interface AnalyticsSummary {
  period: string;
  days: number;
  totalInbound: number;
  totalOutbound: number;
  avgResponseMs: number;
  p95ResponseMs: number;
  maxResponseMs: number;
  topCommands: { command: string; count: number }[];
  peakHours: { hour: number; count: number }[];
  totalErrors: number;
  errorsByType: Record<string, number>;
  totalTokensEstimated: number;
  avgSessionDurationSec: number;
}

function summarizeDays(days: DailyAnalytics[], periodLabel: string): AnalyticsSummary {
  let totalInbound = 0;
  let totalOutbound = 0;
  const allResponseTimes: number[] = [];
  const commandTotals: Record<string, number> = {};
  const hourlyTotals = new Array(24).fill(0);
  let totalErrors = 0;
  const errorsByType: Record<string, number> = {};
  let totalTokens = 0;
  const allSessionDurations: number[] = [];

  for (const day of days) {
    totalInbound += day.messages.inbound;
    totalOutbound += day.messages.outbound;
    allResponseTimes.push(...day.responseTimes);
    for (const [cmd, count] of Object.entries(day.commandUsage)) {
      commandTotals[cmd] = (commandTotals[cmd] || 0) + count;
    }
    for (let h = 0; h < 24; h++) {
      hourlyTotals[h] += day.hourlyActivity[h];
    }
    totalErrors += day.errors.total;
    for (const [type, count] of Object.entries(day.errors.byType)) {
      errorsByType[type] = (errorsByType[type] || 0) + count;
    }
    totalTokens += day.tokenUsage.estimated;
    allSessionDurations.push(...day.sessionDurations);
  }

  const sortedTimes = allResponseTimes.slice().sort((a, b) => a - b);
  const avgMs = sortedTimes.length > 0
    ? Math.round(sortedTimes.reduce((a, b) => a + b, 0) / sortedTimes.length)
    : 0;

  const topCommands = Object.entries(commandTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([command, count]) => ({ command, count }));

  const peakHours = hourlyTotals
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const avgSessionDuration = allSessionDurations.length > 0
    ? Math.round(allSessionDurations.reduce((a, b) => a + b, 0) / allSessionDurations.length)
    : 0;

  return {
    period: periodLabel,
    days: days.length,
    totalInbound,
    totalOutbound,
    avgResponseMs: avgMs,
    p95ResponseMs: Math.round(percentile(sortedTimes, 95)),
    maxResponseMs: sortedTimes.length > 0 ? sortedTimes[sortedTimes.length - 1] : 0,
    topCommands,
    peakHours,
    totalErrors,
    errorsByType,
    totalTokensEstimated: totalTokens,
    avgSessionDurationSec: avgSessionDuration,
  };
}

function loadDaysRange(numDays: number): DailyAnalytics[] {
  const result: DailyAnalytics[] = [];
  const now = new Date();

  for (let i = 0; i < numDays; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split("T")[0];
    const path = filePath(key);
    if (existsSync(path)) {
      result.push(loadDay(key));
    }
  }
  return result;
}

export function getTodayStats(): AnalyticsSummary {
  const today = loadDay(todayKey());
  return summarizeDays([today], "Today");
}

export function getWeekStats(): AnalyticsSummary {
  return summarizeDays(loadDaysRange(7), "Last 7 days");
}

export function getMonthStats(): AnalyticsSummary {
  return summarizeDays(loadDaysRange(30), "Last 30 days");
}

export function getRecentErrorTimestamps(): number[] {
  const data = loadDay(todayKey());
  return data.errors.timestamps;
}

/**
 * Get errors per minute over the last N minutes.
 */
export function getErrorRate(windowMinutes: number = 10): number {
  const timestamps = getRecentErrorTimestamps();
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const recent = timestamps.filter((t) => t >= cutoff);
  return recent.length / windowMinutes;
}

/**
 * Get average error rate across the day (for spike detection).
 */
export function getDailyAverageErrorRate(): number {
  const data = loadDay(todayKey());
  const hoursElapsed = new Date().getHours() + 1;
  if (hoursElapsed === 0) return 0;
  return data.errors.total / (hoursElapsed * 60); // errors per minute
}

// --- Formatting ---

export function formatAnalytics(summary: AnalyticsSummary): string {
  const lines: string[] = [];

  lines.push(`*${summary.period}*`);
  lines.push("");
  lines.push(`Messages in: ${summary.totalInbound}`);
  lines.push(`Messages out: ${summary.totalOutbound}`);
  lines.push("");
  lines.push(`Response times:`);
  lines.push(`  Avg: ${summary.avgResponseMs}ms`);
  lines.push(`  P95: ${summary.p95ResponseMs}ms`);
  lines.push(`  Max: ${summary.maxResponseMs}ms`);
  lines.push("");
  lines.push(`Errors: ${summary.totalErrors}`);
  if (Object.keys(summary.errorsByType).length > 0) {
    for (const [type, count] of Object.entries(summary.errorsByType)) {
      lines.push(`  ${type}: ${count}`);
    }
  }
  lines.push("");
  lines.push(`Tokens (est): ${summary.totalTokensEstimated.toLocaleString()}`);
  if (summary.avgSessionDurationSec > 0) {
    const mins = Math.round(summary.avgSessionDurationSec / 60);
    lines.push(`Avg session: ${mins}m`);
  }

  if (summary.topCommands.length > 0) {
    lines.push("");
    lines.push("Top commands:");
    for (const { command, count } of summary.topCommands.slice(0, 5)) {
      lines.push(`  /${command}: ${count}`);
    }
  }

  if (summary.peakHours.length > 0) {
    lines.push("");
    lines.push("Peak hours:");
    for (const { hour, count } of summary.peakHours.slice(0, 3)) {
      lines.push(`  ${hour.toString().padStart(2, "0")}:00 - ${count} msgs`);
    }
  }

  return lines.join("\n");
}

// --- Cleanup ---

export function cleanOldAnalytics(): void {
  ensureDir();
  try {
    const files = readdirSync(ANALYTICS_DIR);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
    const cutoffStr = cutoffDate.toISOString().split("T")[0];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const dateStr = file.replace(".json", "");
      if (dateStr < cutoffStr) {
        unlinkSync(join(ANALYTICS_DIR, file));
        debug("analytics", "cleaned_old_file", { file });
      }
    }
  } catch (err) {
    logError("analytics", "cleanup_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Initialize analytics: ensure directory exists and clean old data.
 */
export function initAnalytics(): void {
  ensureDir();
  cleanOldAnalytics();
  info("analytics", "initialized", { dir: ANALYTICS_DIR });
}
