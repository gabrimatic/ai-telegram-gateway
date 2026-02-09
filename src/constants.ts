/**
 * Constants for the Telegram Gateway bot
 */

import { env } from "./env";

// Bot version
export const BOT_VERSION = "1.1.0";

// File paths for persistent storage (configurable via environment)
export const ALLOWLIST_PATH = env.TG_ALLOWLIST_FILE;
export const TODOS_PATH = env.TG_TODOS_FILE;
export const NOTES_PATH = env.TG_NOTES_FILE;
export const REMINDERS_PATH = env.TG_REMINDERS_FILE;

export const ICONS = {
  // Status
  success: "\u2705", error: "\u274C", pending: "\u23F3", warning: "\u26A0\uFE0F",
  // Commands
  todo: "\uD83D\uDCDD", note: "\uD83D\uDCCC", reminder: "\u23F0", timer: "\u23F1\uFE0F",
  weather: "\uD83C\uDF24\uFE0F", translate: "\uD83C\uDF0D", calc: "\uD83D\uDD22", time: "\uD83D\uDD50",
  battery: "\uD83D\uDD0B", cpu: "\u26A1", memory: "\uD83E\uDDE0", disk: "\uD83D\uDCBE",
  add: "\u2795", done: "\u2714\uFE0F", clear: "\uD83D\uDDD1\uFE0F", refresh: "\uD83D\uDD04", back: "\u25C0\uFE0F",
  settings: "\u2699\uFE0F", help: "\u2753", bot: "\uD83E\uDD16",
};
