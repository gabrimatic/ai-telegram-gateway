/**
 * Storage functions for persistent data
 */

import { readFileSync, existsSync, writeFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import { error } from "./logger";
import {
  ALLOWLIST_PATH,
  TODOS_PATH,
  NOTES_PATH,
  REMINDERS_PATH,
} from "./constants";
import type {
  Allowlist,
  TodoList,
  NotesList,
  RemindersList,
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
  const tempPath = join(dirname(filePath), `.${Date.now()}.tmp`);
  writeFileSync(tempPath, content);
  renameSync(tempPath, filePath);
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
    return JSON.parse(content) as Allowlist;
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

export function loadTodos(): TodoList {
  if (!existsSync(TODOS_PATH)) {
    return { items: [], nextId: 1 };
  }
  try {
    return JSON.parse(readFileSync(TODOS_PATH, "utf-8")) as TodoList;
  } catch {
    return { items: [], nextId: 1 };
  }
}

export function saveTodos(todos: TodoList): void {
  atomicWriteSync(TODOS_PATH, JSON.stringify(todos, null, 2));
}

export function loadNotes(): NotesList {
  if (!existsSync(NOTES_PATH)) {
    return { items: [], nextId: 1 };
  }
  try {
    return JSON.parse(readFileSync(NOTES_PATH, "utf-8")) as NotesList;
  } catch {
    return { items: [], nextId: 1 };
  }
}

export function saveNotes(notes: NotesList): void {
  atomicWriteSync(NOTES_PATH, JSON.stringify(notes, null, 2));
}

export function loadReminders(): RemindersList {
  if (!existsSync(REMINDERS_PATH)) {
    return { items: [], nextId: 1 };
  }
  try {
    return JSON.parse(readFileSync(REMINDERS_PATH, "utf-8")) as RemindersList;
  } catch {
    return { items: [], nextId: 1 };
  }
}

export function saveReminders(reminders: RemindersList): void {
  atomicWriteSync(REMINDERS_PATH, JSON.stringify(reminders, null, 2));
}
