/**
 * Storage functions for persistent data
 */

import { readFileSync, existsSync, writeFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import { error } from "./logger";
import {
  ALLOWLIST_PATH,
} from "./constants";
import type {
  Allowlist,
} from "./types";

// Simple mutex for allowlist operations
let allowlistLock = false;
const LOCK_TIMEOUT_MS = 5000;

export async function withAllowlistLock<T>(fn: () => T): Promise<T> {
  // Wait for lock to be released (with timeout to prevent deadlock)
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (allowlistLock) {
    if (Date.now() > deadline) {
      error("storage", "allowlist_lock_timeout", { timeoutMs: LOCK_TIMEOUT_MS });
      allowlistLock = false; // Force release stale lock
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  allowlistLock = true;
  try {
    return fn();
  } finally {
    allowlistLock = false;
  }
}

/**
 * Atomic write: write to temp file then rename (prevents corruption on crash)
 */
function atomicWriteSync(filePath: string, content: string): void {
  const dir = dirname(filePath);
  // Ensure parent directory exists
  if (!existsSync(dir)) {
    const { mkdirSync } = require("fs");
    mkdirSync(dir, { recursive: true });
  }
  const tempPath = join(dir, `.${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, content);
    renameSync(tempPath, filePath);
  } catch (err) {
    // Clean up temp file if rename failed
    try {
      if (existsSync(tempPath)) {
        const { unlinkSync } = require("fs");
        unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Safely parse JSON with fallback. Logs corruption but doesn't crash.
 */
function safeJsonParse<T>(content: string, fallback: T, context: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (err) {
    error("storage", "json_parse_failed", {
      context,
      error: err instanceof Error ? err.message : String(err),
      contentLength: content.length,
      contentPreview: content.substring(0, 100),
    });
    return fallback;
  }
}

export function generatePairingCode(): string {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

export function isUserAllowed(userId: string, allowlist: Allowlist): boolean {
  return allowlist.allowedUsers.includes(userId);
}

export function isAdminUser(userId: string, allowlist: Allowlist): boolean {
  return allowlist.allowedUsers.length > 0 && allowlist.allowedUsers[0] === userId;
}

export function loadAllowlistSync(): Allowlist {
  if (!existsSync(ALLOWLIST_PATH)) {
    const defaultAllowlist: Allowlist = {
      allowedUsers: [],
      pairingEnabled: true,
      pairingCode: generatePairingCode(),
    };
    writeFileSync(ALLOWLIST_PATH, JSON.stringify(defaultAllowlist, null, 2));
    return defaultAllowlist;
  }

  try {
    const content = readFileSync(ALLOWLIST_PATH, "utf-8");
    const parsed = safeJsonParse<Allowlist>(content, {
      allowedUsers: [],
      pairingEnabled: false,
      pairingCode: "",
    }, "allowlist");
    // Validate structure to guard against partially corrupted data
    if (!Array.isArray(parsed.allowedUsers)) {
      parsed.allowedUsers = [];
    }
    if (typeof parsed.pairingEnabled !== "boolean") {
      parsed.pairingEnabled = false;
    }
    if (typeof parsed.pairingCode !== "string") {
      parsed.pairingCode = "";
    }
    return parsed;
  } catch (err) {
    error("storage", "allowlist_load_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      allowedUsers: [],
      pairingEnabled: false,
      pairingCode: "",
    };
  }
}

export function saveAllowlistSync(allowlist: Allowlist): void {
  atomicWriteSync(ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2));
}

export async function loadAllowlist(): Promise<Allowlist> {
  return withAllowlistLock(() => loadAllowlistSync());
}

export async function saveAllowlist(allowlist: Allowlist): Promise<void> {
  return withAllowlistLock(() => saveAllowlistSync(allowlist));
}

