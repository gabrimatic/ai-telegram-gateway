/**
 * Unified service lifecycle manager for voice services
 * Manages WhisperKit (speech-to-text) server
 */

import * as http from "http";
import { spawn, execSync, ChildProcess } from "child_process";
import { env, WHISPERKIT_BASE_URL } from "./env";
import { info, error as logError, debug } from "./logger";
import { CircuitBreaker, CircuitBreakerError } from "./circuit-breaker";
import { sendAdminAlert } from "./alerting";

// WhisperKit configuration
const WHISPERKIT_PORT = env.WHISPERKIT_PORT;
const WHISPERKIT_CHECK_URL = `${WHISPERKIT_BASE_URL}/`;
const WHISPERKIT_MODEL = process.env.WHISPERKIT_MODEL || "large-v3-v20240930_turbo";
const WHISPERKIT_STARTUP_TIMEOUT = 90000; // 90 seconds for model loading

// Health monitor configuration
const HEALTH_CHECK_INTERVAL = 60000; // 60 seconds
const MAX_CONSECUTIVE_FAILURES = 3;

// Service operation timeout
const SERVICE_OPERATION_TIMEOUT = 30000; // 30 seconds

// Service state tracking
export type ServiceState = "healthy" | "degraded" | "unavailable";

interface ServiceStatus {
  whisperKit: ServiceState;
}

const serviceStatus: ServiceStatus = {
  whisperKit: "unavailable",
};

// Circuit breaker for service calls
const whisperKitCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  recoveryTimeoutMs: 60000, // 1 minute
  successThreshold: 2,
});

// Process tracking
let whisperKitProcess: ChildProcess | null = null;
let healthMonitorInterval: ReturnType<typeof setInterval> | null = null;
let whisperKitFailures = 0;

/**
 * Create a timeout promise that rejects after specified ms.
 * Cleans up the timer when the wrapped promise settles first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    timeoutPromise,
  ]);
}

/**
 * Update service state based on circuit breaker state
 */
function updateServiceState(service: "whisperKit", isRunning: boolean): void {
  const breaker = whisperKitCircuitBreaker;
  const breakerState = breaker.getState();

  if (!isRunning || breakerState === "open") {
    serviceStatus[service] = "unavailable";
  } else if (breakerState === "half-open") {
    serviceStatus[service] = "degraded";
  } else {
    serviceStatus[service] = "healthy";
  }
}

/**
 * Get current service states for /status command
 */
export function getServiceStates(): ServiceStatus {
  return { ...serviceStatus };
}

/**
 * Check if WhisperKit server is running
 */
export function isWhisperKitRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(WHISPERKIT_CHECK_URL, { timeout: 5000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Check WhisperKit with circuit breaker protection
 */
export async function checkWhisperKitWithCircuitBreaker(): Promise<boolean> {
  try {
    const result = await whisperKitCircuitBreaker.execute(async () => {
      return await withTimeout(isWhisperKitRunning(), SERVICE_OPERATION_TIMEOUT, "WhisperKit check");
    });
    updateServiceState("whisperKit", result);
    return result;
  } catch (err) {
    updateServiceState("whisperKit", false);
    if (err instanceof CircuitBreakerError) {
      debug("service-manager", "whisperkit_circuit_open");
    } else {
      logError("service-manager", "whisperkit_check_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }
}

/**
 * Start WhisperKit server and wait until ready
 */
export async function startWhisperKitServer(): Promise<boolean> {
  // Check if already running
  if (await isWhisperKitRunning()) {
    info("service-manager", "whisperkit_already_running");
    return true;
  }

  info("service-manager", "starting_whisperkit", { model: WHISPERKIT_MODEL });

  try {
    whisperKitProcess = spawn(
      "whisperkit-cli",
      ["serve", "--model", WHISPERKIT_MODEL],
      {
        detached: true,
        stdio: "ignore",
      }
    );

    // Handle spawn errors
    whisperKitProcess.on("error", (err) => {
      logError("service-manager", "whisperkit_spawn_error", {
        error: err.message,
      });
    });

    whisperKitProcess.unref();

    // Wait for server to be ready
    const startTime = Date.now();
    const checkInterval = 1000;

    while (Date.now() - startTime < WHISPERKIT_STARTUP_TIMEOUT) {
      await new Promise((resolve) => setTimeout(resolve, checkInterval));

      if (await isWhisperKitRunning()) {
        info("service-manager", "whisperkit_ready", {
          startupTimeMs: Date.now() - startTime,
        });
        return true;
      }

      // Log progress every 10 seconds
      const elapsed = Date.now() - startTime;
      if (elapsed % 10000 < checkInterval) {
        debug("service-manager", "whisperkit_loading", { elapsedMs: elapsed });
      }
    }

    logError("service-manager", "whisperkit_startup_timeout", {
      timeoutMs: WHISPERKIT_STARTUP_TIMEOUT,
    });
    return false;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes("ENOENT")) {
      logError("service-manager", "whisperkit_not_found", {
        error: "whisperkit-cli not found. Install with: brew install whisperkit-cli",
      });
    } else {
      logError("service-manager", "whisperkit_start_failed", { error: errorMsg });
    }
    return false;
  }
}

/**
 * Stop WhisperKit server
 */
function stopWhisperKitServer(): void {
  info("service-manager", "stopping_whisperkit");

  // Kill tracked process
  if (whisperKitProcess && whisperKitProcess.pid) {
    try {
      process.kill(whisperKitProcess.pid, "SIGKILL");
      info("service-manager", "whisperkit_process_killed", { pid: whisperKitProcess.pid });
    } catch {
      // Process may have already exited
    }
    whisperKitProcess = null;
  }

  // pkill fallback for orphans
  try {
    execSync("pkill -9 -f whisperkit-cli", { timeout: 2000, stdio: "ignore" });
  } catch {
    // No process to kill or pkill failed
  }
}

/**
 * Start voice services on startup
 * Only starts WhisperKit (STT) - TTS uses cloud API (OpenAI)
 */
export async function startServices(): Promise<void> {
  info("service-manager", "starting_voice_services");

  const whisperKitStarted = await startWhisperKitServer();

  // Update initial state
  updateServiceState("whisperKit", whisperKitStarted);

  info("service-manager", "services_started", {
    whisperKit: whisperKitStarted,
    tts: "OpenAI cloud API (gpt-4o-mini-tts)",
  });

  if (!whisperKitStarted) {
    info("service-manager", "whisperkit_not_available", {
      message: "Voice transcription will be unavailable",
    });
  }
}

/**
 * Stop all services (called on gateway shutdown)
 */
export function stopServices(): void {
  info("service-manager", "stopping_all_services");
  stopWhisperKitServer();
}

/**
 * Perform health check and restart services if needed
 */
async function performHealthCheck(): Promise<void> {
  // Check WhisperKit with circuit breaker
  const whisperKitHealthy = await checkWhisperKitWithCircuitBreaker();
  if (!whisperKitHealthy) {
    whisperKitFailures++;
    debug("service-manager", "whisperkit_health_check_failed", {
      consecutiveFailures: whisperKitFailures,
      circuitState: whisperKitCircuitBreaker.getState(),
    });

    if (whisperKitFailures >= MAX_CONSECUTIVE_FAILURES) {
      info("service-manager", "whisperkit_auto_restart", {
        reason: "consecutive health check failures",
        failures: whisperKitFailures,
      });
      stopWhisperKitServer();
      const restarted = await startWhisperKitServer();
      if (restarted) {
        whisperKitFailures = 0;
        whisperKitCircuitBreaker.reset();
        updateServiceState("whisperKit", true);
      } else {
        await sendAdminAlert(
          `WhisperKit failed to restart after ${whisperKitFailures} consecutive failures`,
          "warning",
          "service_down"
        );
      }
    }
  } else {
    whisperKitFailures = 0;
  }
}

/**
 * Start periodic health monitoring
 */
export function startServiceHealthMonitor(): void {
  if (healthMonitorInterval) {
    return;
  }

  info("service-manager", "starting_health_monitor", {
    intervalMs: HEALTH_CHECK_INTERVAL,
  });

  healthMonitorInterval = setInterval(() => {
    performHealthCheck().catch((err) => {
      logError("service-manager", "health_check_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, HEALTH_CHECK_INTERVAL);
}

/**
 * Stop health monitoring
 */
export function stopServiceHealthMonitor(): void {
  if (healthMonitorInterval) {
    clearInterval(healthMonitorInterval);
    healthMonitorInterval = null;
    info("service-manager", "stopped_health_monitor");
  }
}
