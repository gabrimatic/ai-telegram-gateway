/**
 * Proactive auth verification and degraded mode for the AI backend.
 *
 * Runs `claude auth status` periodically to detect token expiry before
 * users hit it.  When auth fails the gateway enters "degraded mode" -
 * new messages are rejected with a friendly error instead of spawning
 * sessions that will immediately die.
 */

import { execSync } from "child_process";
import { info, warn, debug } from "../logger";
import { sendAdminAlert } from "../alerting";

let degradedMode = false;
let degradedReason = "";
let periodicCheckTimer: NodeJS.Timeout | null = null;

const AUTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const AUTH_CHECK_TIMEOUT_MS = 10 * 1000; // 10 seconds

export function isDegradedMode(): boolean {
  return degradedMode;
}

export function getDegradedReason(): string {
  return degradedReason;
}

export function enterDegradedMode(reason: string): void {
  if (degradedMode) return;
  degradedMode = true;
  degradedReason = reason;
  warn("auth-check", "degraded_mode_entered", { reason });
}

export function exitDegradedMode(): void {
  if (!degradedMode) return;
  const prevReason = degradedReason;
  degradedMode = false;
  degradedReason = "";
  info("auth-check", "degraded_mode_exited", { previousReason: prevReason });
}

/**
 * Run `claude auth status` and return true if the CLI is authenticated.
 * Strips CLAUDECODE env var to avoid recursive invocation issues.
 */
export function checkAuthStatus(): boolean {
  try {
    const filteredEnv = { ...process.env };
    delete filteredEnv.CLAUDECODE;

    const result = execSync("claude auth status --json", {
      encoding: "utf-8",
      timeout: AUTH_CHECK_TIMEOUT_MS,
      env: filteredEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parsed = JSON.parse(result.trim());
    return parsed.loggedIn === true;
  } catch (err) {
    debug("auth-check", "check_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function startPeriodicAuthCheck(): void {
  if (periodicCheckTimer) return;

  periodicCheckTimer = setInterval(async () => {
    try {
      const isAuthed = checkAuthStatus();

      if (!isAuthed && !degradedMode) {
        enterDegradedMode("CLI auth check failed");
        await sendAdminAlert(
          "CLI authentication expired. Gateway entering degraded mode - messages will be rejected until auth is restored.",
          "critical",
          "service_down"
        );
      } else if (isAuthed && degradedMode) {
        exitDegradedMode();
        await sendAdminAlert(
          "CLI authentication restored. Gateway resuming normal operation.",
          "info",
          "service_down"
        );
      }
    } catch (err) {
      debug("auth-check", "periodic_check_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, AUTH_CHECK_INTERVAL_MS);

  periodicCheckTimer.unref();
  info("auth-check", "periodic_check_started", { intervalMs: AUTH_CHECK_INTERVAL_MS });
}

export function stopPeriodicAuthCheck(): void {
  if (periodicCheckTimer) {
    clearInterval(periodicCheckTimer);
    periodicCheckTimer = null;
    info("auth-check", "periodic_check_stopped");
  }
}
