/**
 * Safe self-deployment pipeline for the Telegram bot gateway.
 * Handles build, drain, restart, rollback, and post-deploy health checks.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { dirname } from "path";
import { env } from "./env";
import { info, warn, error } from "./logger";

const STATE_PATH = `${process.env.HOME || require("os").homedir()}/.claude/gateway/deploy-state.json`;

const STALE_LOCK_MS = 5 * 60 * 1000; // 5 minutes
const DRAIN_POLL_MS = 500;
const DRAIN_TIMEOUT_MS = 15 * 1000;

export interface DeployState {
  status: "idle" | "deploying" | "validating";
  startedAt?: string;
  previousCommit?: string;
  currentCommit?: string;
  initiatedBy?: string;
  phase?: string;
}

export interface DeployResult {
  success: boolean;
  message: string;
  phase?: string;
  output?: string;
}

const DEFAULT_STATE: DeployState = { status: "idle" };

let deployPending = false;

function ensureDir(): void {
  const dir = dirname(STATE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadState(): DeployState {
  if (!existsSync(STATE_PATH)) {
    return { ...DEFAULT_STATE };
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as DeployState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state: DeployState): void {
  ensureDir();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function resetToIdle(): void {
  saveState({ ...DEFAULT_STATE });
  deployPending = false;
}

function exec(cmd: string, timeoutMs: number = 30000): string {
  return execSync(cmd, {
    cwd: env.TG_PROJECT_DIR,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 5 * 1024 * 1024,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getDeployState(): DeployState {
  return loadState();
}

export function isDeployPending(): boolean {
  return deployPending;
}

export async function executeDeploy(
  initiatedBy: string,
  getInFlightCount: () => number
): Promise<DeployResult> {
  // --- Lock ---
  const state = loadState();
  if (state.status !== "idle") {
    if (
      state.status === "deploying" &&
      state.startedAt &&
      Date.now() - new Date(state.startedAt).getTime() > STALE_LOCK_MS
    ) {
      warn("deployer", "stale_lock_override", {
        startedAt: state.startedAt,
        previousInitiator: state.initiatedBy,
      });
    } else {
      return {
        success: false,
        message: `Deploy already in progress (status: ${state.status}, phase: ${state.phase || "unknown"})`,
        phase: "lock",
      };
    }
  }

  const deployState: DeployState = {
    status: "deploying",
    startedAt: new Date().toISOString(),
    initiatedBy,
    phase: "pre-flight",
  };
  saveState(deployState);
  info("deployer", "deploy_started", { initiatedBy });

  try {
    // --- Pre-flight ---
    let porcelain: string;
    try {
      porcelain = exec("git status --porcelain").trim();
    } catch (err: unknown) {
      resetToIdle();
      return {
        success: false,
        message: "Failed to check git status",
        phase: "pre-flight",
        output: String(err),
      };
    }

    if (porcelain.length > 0) {
      resetToIdle();
      return {
        success: false,
        message: "Deploy aborted: working tree is dirty. Commit/stash your changes before deploy.",
        phase: "pre-flight",
        output: porcelain,
      };
    }

    const previousCommit = exec("git rev-parse HEAD").trim();
    deployState.previousCommit = previousCommit;
    saveState(deployState);

    // --- Build ---
    deployState.phase = "build";
    saveState(deployState);
    info("deployer", "build_started");

    let buildOutput: string;
    try {
      buildOutput = exec("npm run build");
    } catch (err: unknown) {
      const output = err instanceof Error ? (err as { stdout?: string }).stdout || err.message : String(err);
      error("deployer", "build_failed", { output });
      resetToIdle();
      return {
        success: false,
        message: "Build failed",
        phase: "build",
        output,
      };
    }
    info("deployer", "build_succeeded");

    // --- Drain ---
    deployState.phase = "drain";
    saveState(deployState);
    deployPending = true;
    info("deployer", "drain_started");

    const drainStart = Date.now();
    while (getInFlightCount() > 0) {
      if (Date.now() - drainStart > DRAIN_TIMEOUT_MS) {
        warn("deployer", "drain_timeout", { inFlight: getInFlightCount() });
        break;
      }
      await sleep(DRAIN_POLL_MS);
    }
    info("deployer", "drain_complete", { waited: Date.now() - drainStart });

    // --- Record ---
    const currentCommit = exec("git rev-parse HEAD").trim();
    deployState.status = "validating";
    deployState.currentCommit = currentCommit;
    deployState.phase = "restart";
    saveState(deployState);
    info("deployer", "restarting", { previousCommit, currentCommit });

    // --- Restart ---
    execSync(`pm2 restart "${env.TG_PM2_APP_NAME}"`, { encoding: "utf-8" });

    // Process dies here; this return is unlikely to execute
    return { success: true, message: "Restart issued" };
  } catch (err: unknown) {
    error("deployer", "deploy_error", { error: String(err) });
    resetToIdle();
    return {
      success: false,
      message: "Unexpected error during deploy",
      phase: deployState.phase,
      output: String(err),
    };
  }
}

export function checkPostDeployHealth(): void {
  const state = loadState();
  if (state.status === "validating") {
    info("deployer", "post_deploy_success", {
      previousCommit: state.previousCommit,
      currentCommit: state.currentCommit,
    });
    resetToIdle();
  }
}

export async function checkRollbackNeeded(): Promise<boolean> {
  const state = loadState();
  if (state.status !== "validating") {
    return false;
  }

  if (!state.previousCommit) {
    warn("deployer", "no_previous_commit_for_rollback");
    resetToIdle();
    return false;
  }

  // Check PM2 restart count
  let restartCount = 0;
  try {
    const jlist = execSync("pm2 jlist", { encoding: "utf-8" });
    const processes = JSON.parse(jlist) as Array<{
      name?: string;
      pm2_env?: { restart_time?: number };
    }>;
    const gw = processes.find((p) => p.name === env.TG_PM2_APP_NAME);
    restartCount = gw?.pm2_env?.restart_time ?? 0;
  } catch {
    warn("deployer", "pm2_jlist_failed");
  }

  if (restartCount < 3) {
    return false;
  }

  warn("deployer", "rollback_triggered", {
    restartCount,
    previousCommit: state.previousCommit,
    currentCommit: state.currentCommit,
  });

  try {
    exec(`git checkout ${state.previousCommit} -- .`);
    exec("npm run build");
    info("deployer", "rollback_complete", { restoredCommit: state.previousCommit });
    resetToIdle();
    return true;
  } catch (err: unknown) {
    error("deployer", "rollback_failed", { error: String(err) });
    resetToIdle();
    return false;
  }
}

export async function manualRollback(): Promise<DeployResult> {
  const state = loadState();

  if (!state.previousCommit) {
    return {
      success: false,
      message: "No previous commit available for rollback",
    };
  }

  info("deployer", "manual_rollback_started", { targetCommit: state.previousCommit });

  try {
    exec(`git checkout ${state.previousCommit} -- .`);
  } catch (err: unknown) {
    error("deployer", "manual_rollback_checkout_failed", { error: String(err) });
    return {
      success: false,
      message: "Failed to checkout previous commit",
      phase: "checkout",
      output: String(err),
    };
  }

  try {
    exec("npm run build");
  } catch (err: unknown) {
    error("deployer", "manual_rollback_build_failed", { error: String(err) });
    return {
      success: false,
      message: "Rollback build failed",
      phase: "build",
      output: String(err),
    };
  }

  const restoredCommit = state.previousCommit;
  resetToIdle();
  info("deployer", "manual_rollback_complete", { restoredCommit });

  return {
    success: true,
    message: `Rolled back to ${restoredCommit}`,
  };
}
