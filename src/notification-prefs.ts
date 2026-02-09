/**
 * Notification preference management (quiet mode, DND)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export const PREFS_PATH = `${process.env.HOME || require("os").homedir()}/.claude/gateway/notification-prefs.json`;

export interface NotificationPrefs {
  quietMode: boolean;
  dndUntil: string | null; // ISO timestamp or null
}

const DEFAULT_PREFS: NotificationPrefs = {
  quietMode: false,
  dndUntil: null,
};

function ensureDir(): void {
  const dir = dirname(PREFS_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadPrefs(): NotificationPrefs {
  if (!existsSync(PREFS_PATH)) {
    return { ...DEFAULT_PREFS };
  }
  try {
    return JSON.parse(readFileSync(PREFS_PATH, "utf-8")) as NotificationPrefs;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: NotificationPrefs): void {
  ensureDir();
  writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2));
}

export function isQuietMode(): boolean {
  const prefs = loadPrefs();
  return prefs.quietMode;
}

export function isDND(): boolean {
  const prefs = loadPrefs();
  if (!prefs.dndUntil) return false;
  const until = new Date(prefs.dndUntil);
  if (Date.now() >= until.getTime()) {
    // DND expired, clear it
    prefs.dndUntil = null;
    savePrefs(prefs);
    return false;
  }
  return true;
}

export function toggleQuietMode(): boolean {
  const prefs = loadPrefs();
  prefs.quietMode = !prefs.quietMode;
  savePrefs(prefs);
  return prefs.quietMode;
}

export function setDND(durationMs: number): string {
  const prefs = loadPrefs();
  const until = new Date(Date.now() + durationMs);
  prefs.dndUntil = until.toISOString();
  savePrefs(prefs);
  return until.toISOString();
}

export function clearDND(): void {
  const prefs = loadPrefs();
  prefs.dndUntil = null;
  savePrefs(prefs);
}

export function getDNDRemaining(): number | null {
  const prefs = loadPrefs();
  if (!prefs.dndUntil) return null;
  const remaining = new Date(prefs.dndUntil).getTime() - Date.now();
  if (remaining <= 0) {
    prefs.dndUntil = null;
    savePrefs(prefs);
    return null;
  }
  return remaining;
}
