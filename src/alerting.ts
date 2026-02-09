/**
 * Alerting module for sending admin notifications via Telegram
 * Throttles alerts to prevent spam (max 1 alert per category per throttle period)
 */

import { readFileSync, existsSync } from "fs";
import { Bot } from "grammy";
import { getConfig } from "./config";
import { info, warn, error } from "./logger";
import { ALLOWLIST_PATH } from "./constants";
import type { Allowlist } from "./types";

export type AlertCategory =
  | "service_down"
  | "memory_critical"
  | "disk_low"
  | "consecutive_failures";

export type AlertSeverity = "info" | "warning" | "critical";

// Track last alert time per category
const lastAlertTime: Map<AlertCategory, number> = new Map();

// Bot instance reference (set via setBotInstance)
let botInstance: Bot | null = null;

/**
 * Set the bot instance for sending alerts.
 * Must be called during initialization before alerts can be sent.
 */
export function setBotInstance(bot: Bot): void {
  botInstance = bot;
  info("alerting", "bot_instance_set");
}

// Cache admin chat ID to avoid re-reading allowlist file on every alert
let cachedAdminChatId: string | null | undefined = undefined; // undefined = not cached yet

/**
 * Get the admin chat ID from the allowlist (first user).
 * Cached after first read since admin rarely changes during runtime.
 */
function getAdminChatId(): string | null {
  if (cachedAdminChatId !== undefined) return cachedAdminChatId;

  if (!existsSync(ALLOWLIST_PATH)) {
    warn("alerting", "allowlist_not_found", { path: ALLOWLIST_PATH });
    cachedAdminChatId = null;
    return null;
  }

  try {
    const content = readFileSync(ALLOWLIST_PATH, "utf-8");
    const allowlist: Allowlist = JSON.parse(content);

    if (!allowlist.allowedUsers || allowlist.allowedUsers.length === 0) {
      warn("alerting", "no_admin_user");
      cachedAdminChatId = null;
      return null;
    }

    cachedAdminChatId = allowlist.allowedUsers[0];
    return cachedAdminChatId;
  } catch (err) {
    error("alerting", "allowlist_read_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    cachedAdminChatId = null;
    return null;
  }
}

/**
 * Check if an alert should be throttled.
 * Returns true if the alert should be suppressed.
 */
function shouldThrottle(category: AlertCategory): boolean {
  const config = getConfig();
  const throttleMs = config.alerting.throttleMinutes * 60 * 1000;
  const lastTime = lastAlertTime.get(category);

  if (!lastTime) {
    return false;
  }

  return Date.now() - lastTime < throttleMs;
}

/**
 * Format alert message with severity prefix.
 */
function formatAlertMessage(message: string, severity: AlertSeverity): string {
  const prefixes: Record<AlertSeverity, string> = {
    info: "[INFO]",
    warning: "[WARNING]",
    critical: "[CRITICAL]",
  };

  return `${prefixes[severity]} ${message}`;
}

/**
 * Send an admin alert via Telegram.
 * Alerts are throttled by category to prevent spam.
 *
 * @param message - The alert message to send
 * @param severity - Alert severity level
 * @param category - Alert category for throttling
 * @returns true if alert was sent, false if throttled or failed
 */
export async function sendAdminAlert(
  message: string,
  severity: AlertSeverity,
  category: AlertCategory
): Promise<boolean> {
  const config = getConfig();

  // Check if alerting is enabled
  if (!config.alerting.enabled) {
    return false;
  }

  // Check if bot instance is available
  if (!botInstance) {
    warn("alerting", "bot_not_initialized");
    return false;
  }

  // Check throttling
  if (shouldThrottle(category)) {
    info("alerting", "throttled", { category, severity });
    return false;
  }

  // Get admin chat ID
  const adminChatId = getAdminChatId();
  if (!adminChatId) {
    return false;
  }

  try {
    const formattedMessage = formatAlertMessage(message, severity);
    await botInstance.api.sendMessage(adminChatId, formattedMessage);

    // Update throttle tracker
    lastAlertTime.set(category, Date.now());

    info("alerting", "alert_sent", {
      category,
      severity,
      adminChatId,
    });

    return true;
  } catch (err) {
    error("alerting", "send_failed", {
      error: err instanceof Error ? err.message : String(err),
      category,
      severity,
    });
    return false;
  }
}

/**
 * Clear throttle state for a category (useful for testing or manual reset).
 */
export function clearThrottle(category: AlertCategory): void {
  lastAlertTime.delete(category);
}

/**
 * Clear all throttle state.
 */
export function clearAllThrottles(): void {
  lastAlertTime.clear();
}
