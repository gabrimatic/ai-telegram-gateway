/**
 * Command handler for the Telegram Gateway bot
 */

import { Context, InlineKeyboard, InputFile } from "grammy";
import { readFileSync, readdirSync, statSync, existsSync, createWriteStream, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname, basename } from "path";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { restartSession, stopSession, getCurrentModel, getStats as getAIStats, getSessionId, isSessionAlive, getCircuitBreakerState, getAIProviderName, switchModel, getAvailableModels, getProviderForModel, isValidModel } from "./ai";
import { getConfig, ModelName } from "./config";
import { formatStats, getStartTime, getStats as getHealthStats } from "./health";
import { ICONS, BOT_VERSION } from "./constants";
import { getConfiguredProviderName, getProviderDisplayName, getProviderProcessConfig } from "./provider";
import {
  loadAllowlist,
  isUserAllowed,
  isAdminUser,
  loadTodos,
  saveTodos,
  loadNotes,
  saveNotes,
  loadReminders,
  saveReminders,
} from "./storage";
import {
  parseTimeString,
  safeCalc,
  formatUptime,
  formatDuration,
  getWeekNumber,
  safeExec,
  escapeMarkdown,
  validateShellArg,
} from "./utils";
import { forwardToClaude } from "./claude-helpers";
import { error as logError, info as logInfo } from "./logger";
import {
  listProcesses,
  processDetails,
  killProcess,
  dockerList,
  dockerStart,
  dockerStop,
  dockerRestart,
  dockerLogs,
  dockerStats,
  dockerInfo,
  pm2List,
  pm2Restart,
  pm2Stop,
  pm2Start,
  pm2Logs,
  pm2Flush,
  brewList,
  brewOutdated,
  brewUpdate,
  brewUpgrade,
  gitStatus,
  gitLog,
  gitPull,
  diskUsageDetailed,
  largestFiles,
  cleanupSuggestions,
  activeConnections,
  listeningPorts,
  speedTest,
  externalIP,
  systemOverview,
  temperatures,
} from "./system";
import type { TodoItem, NoteItem, ReminderItem } from "./types";
import {
  enableTTSOutput,
  disableTTSOutput,
  getTTSOutputStatus,
} from "./tts";
import {
  createSchedule,
  cancelSchedule,
  getSchedules,
  getScheduleById,
  formatSchedule,
  formatHistory,
} from "./task-scheduler";
import {
  loadSnippets,
  addSnippet,
  deleteSnippet,
  getSnippet,
} from "./snippets";
import {
  toggleQuietMode,
  isQuietMode,
  isDND,
  setDND,
  clearDND,
  getDNDRemaining,
  loadPrefs,
} from "./notification-prefs";
import { getTodayStats, getWeekStats, getMonthStats, formatAnalytics, getErrorRate } from "./analytics";
import { checkResources, formatResourceStatus, formatBytes } from "./resource-monitor";
import { getMetrics } from "./metrics";
import { formatRecoveryLog, formatErrorPatterns, getRecentErrorPatterns } from "./self-heal";
import { isWatchdogRunning } from "./watchdog";
import { executeDeploy, getDeployState, manualRollback } from "./deployer";
import { getInFlightCount } from "./poller";
import { env } from "./env";

// Active timers storage - exported for use by callbacks
export const activeTimers: Map<string, NodeJS.Timeout> = new Map();
const MAX_ACTIVE_TIMERS = 20;
const DANGEROUS_COMMANDS = new Set(["sh", "shlong", "reboot", "sleep"]);
const ADMIN_ONLY_COMMANDS = new Set([
  "analytics",
  "battery",
  "brew",
  "cat",
  "context",
  "cpu",
  "deploy",
  "df",
  "disk",
  "docker",
  "errors",
  "find",
  "git",
  "health",
  "kill",
  "ls",
  "memory",
  "net",
  "pm2",
  "ports",
  "ps",
  "reboot",
  "screenshot",
  "session",
  "sessions",
  "sh",
  "shlong",
  "size",
  "sleep",
  "temp",
  "top",
  "tree",
  "upload",
  "wake",
]);

function dangerousCommandDisabledMessage(): string {
  return `${ICONS.warning} This command is disabled by configuration (TG_ENABLE_DANGEROUS_COMMANDS=false).`;
}

export async function handleCommand(
  ctx: Context,
  command: string,
  args: string
): Promise<boolean> {
  const userId = ctx.from?.id?.toString();
  const allowlist = await loadAllowlist();
  const isAllowed = userId && isUserAllowed(userId, allowlist);
  const isAdmin = userId ? isAdminUser(userId, allowlist) : false;
  const providerName = getProviderDisplayName();

  // Commands that require authorization
  if (!isAllowed) {
    return false;
  }

  if (ADMIN_ONLY_COMMANDS.has(command) && !isAdmin) {
    await ctx.reply("This command is admin-only.");
    return true;
  }

  if (!env.TG_ENABLE_DANGEROUS_COMMANDS && DANGEROUS_COMMANDS.has(command)) {
    await ctx.reply(dangerousCommandDisabledMessage());
    return true;
  }

  try {
  const startTime = Date.now();

  switch (command) {
    // ============ SYSTEM COMMANDS ============

    case "start": {
      const keyboard = new InlineKeyboard()
        .text("\uD83D\uDCCB Todos", "todo_list")
        .text("\uD83D\uDCCC Notes", "notes_list")
        .row()
        .text("\uD83C\uDF24\uFE0F Weather", "weather_menu")
        .text("\u23F1\uFE0F Timer", "timer_menu")
        .row()
        .text("\u2753 Help", "help_show");

      await ctx.reply(
        `*Hey there! \u{1F44B}\u{2728}*\n\nI'm ${providerName}, running via the AI Telegram Gateway! Here's what I can do:\n\n\u{1F4AC} Chat naturally with me\n\u{1F4CE} Send files (photos, docs, audio)\n\u{1F3A4} Send voice messages (transcribed locally)\n\u{2753} Use /help for all the cool commands\n\nQuick actions:`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      return true;
    }

    case "help": {
      const warningLine = getConfig().security.commandWarningsEnabled
        ? `\n\u26A0\uFE0F Dangerous admin commands are enabled${env.TG_ENABLE_DANGEROUS_COMMANDS ? "" : " but currently disabled by TG_ENABLE_DANGEROUS_COMMANDS=false"}.\n`
        : "\n";
      const helpText = `\uD83E\uDD16 *Here's what I can do!*${warningLine}

\uD83D\uDCCB *PRODUCTIVITY*
/todo - Manage your tasks \u{2705}
/note /notes - Quick notes \u{1F4DD}
/remind - Set reminders \u{23F0}
/timer - Countdown timers \u{23F1}\u{FE0F}
/schedule - Task scheduler \u{1F4C5}
/schedules - List scheduled tasks
/snippet - Save/run command snippets
/snippets - List saved snippets

\uD83D\uDD27 *UTILITIES*
/calc - Calculator \u{1F522}
/random /pick - Random stuff \u{1F3B2}
/uuid /time /date

\uD83C\uDF10 *INFO* _(${providerName}-powered)_
/weather /define /translate

\uD83D\uDCBB *SYSTEM & SESSION*
/model - Switch AI model
/tts - Toggle voice output \u{1F50A}
/clear - Fresh start \u{1F9F9}
/disk /memory /cpu /battery
/session - Manage Claude sessions
/context - Current session info

\uD83D\uDDA5 *SERVER MANAGEMENT*
/sys - Full system dashboard
/docker - Docker containers
/pm2 - PM2 process manager
/brew - Homebrew packages
/git - Git repo status
/kill - Kill process by PID
/ports - Listening ports
/net - Network info
/ps - Process list
/df - Detailed disk usage
/top - Top processes by CPU
/temp - CPU temperature
/reboot - Reboot host machine
/sleep - Sleep host machine
/screenshot - Take a screenshot
/deploy - Deploy code changes safely

\uD83D\uDCE6 *SHELL ACCESS*
/sh - Execute shell command
/shlong - Execute long-running command

\uD83D\uDCC1 *FILES*
/ls /pwd /cat /find /size
/tree - Directory tree view
/upload - Download file to path

\uD83C\uDF10 *NETWORK*
/ping - Latency or ping a host
/dns - DNS lookup
/curl - Fetch URL headers

\uD83D\uDD14 *NOTIFICATIONS*
/quiet - Toggle quiet mode
/dnd - Do not disturb

\uD83D\uDCC8 *MONITORING*
/health - System health dashboard
/analytics - Usage stats (today/week/month)
/errors - Error analysis & patterns

\u2139\uFE0F /help /stats /id /version /uptime`;
      await ctx.reply(helpText, { parse_mode: "Markdown" });
      return true;
    }

    case "stats": {
      await ctx.reply(formatStats());
      return true;
    }

    case "clear": {
      await ctx.reply("Clearing session... \u{1F9F9}\u{2728}");

      // Step 1: Stop the managed session gracefully
      stopSession();

      // Step 2: Kill any orphaned provider processes (SIGTERM first for graceful shutdown)
      const providerConfig = getProviderProcessConfig(getConfiguredProviderName(), {
        mcpConfigPath: getConfig().mcpConfigPath,
      });
      if (providerConfig.clearSessionProcessPattern) {
        try {
          safeExec(
            `pkill -TERM -f '${providerConfig.clearSessionProcessPattern}' 2>/dev/null || true`
          );
        } catch {
          // Ignore pkill errors
        }
      }

      // Step 3: Wait briefly for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 500));

      // Step 4: Force kill any remaining processes (SIGKILL)
      if (providerConfig.clearSessionProcessPattern) {
        try {
          safeExec(
            `pkill -KILL -f '${providerConfig.clearSessionProcessPattern}' 2>/dev/null || true`
          );
        } catch {
          // Ignore pkill errors
        }
      }

      // Step 5: Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 200));

      // Step 6: Start fresh session
      await restartSession();
      await ctx.reply("Fresh start! \u{1F31F} Previous conversation is gone, but your todos, notes, and reminders are still safe \u{1F4BE}");
      return true;
    }

    case "id": {
      await ctx.reply(`Your Telegram ID: \`${userId}\` \u{1F194}`, { parse_mode: "Markdown" });
      return true;
    }

    case "ping": {
      if (!args.trim()) {
        // No args: simple latency check
        const latency = Date.now() - startTime;
        await ctx.reply(`Pong! \u{1F3D3} Latency: ${latency}ms`);
        return true;
      }
      // With args: network ping
      await ctx.replyWithChatAction("typing");
      const host = args.trim().split(/\s+/)[0]; // Take only first word for safety
      const hostValidation = validateShellArg(host, "host");
      if (!hostValidation.ok) {
        await ctx.reply(`${ICONS.error} Invalid hostname (${hostValidation.reason}).`);
        return true;
      }
      const output = safeExec(`ping -c 3 "${host}" 2>&1`);
      await ctx.reply(`\uD83C\uDF10 Ping ${host}:\n\`\`\`\n${output}\`\`\``, { parse_mode: "Markdown" });
      return true;
    }

    case "version": {
      await ctx.reply(`Telegram Gateway Bot v${BOT_VERSION} \u{1F680}`);
      return true;
    }

    case "uptime": {
      const startedAt = getStartTime();
      const uptimeMs = Date.now() - startedAt.getTime();
      await ctx.reply(`\u{23F1}\u{FE0F} Uptime: ${formatUptime(uptimeMs)}\nStarted: ${startedAt.toISOString()}`);
      return true;
    }

    // ============ SESSION COMMANDS ============

    case "model": {
      const modelArg = args.trim().toLowerCase() as ModelName;
      const availableModels = getAvailableModels();

      if (!modelArg) {
        // Show current model and all available options
        const current = getCurrentModel();
        const currentProvider = getAIProviderName();
        const keyboard = new InlineKeyboard()
          .text(current === "haiku" ? "\u{2728} Haiku" : "Haiku", "model_haiku")
          .text(current === "opus" ? "\u{2728} Opus" : "Opus", "model_opus")
          .row()
          .text(current === "codex" ? "\u{2728} Codex" : "Codex", "model_codex");
        await ctx.reply(`\u{1F916} Current: *${current}* (${currentProvider})\n\nPick one:`, {
          parse_mode: "Markdown",
          reply_markup: keyboard
        });
        return true;
      }

      if (!isValidModel(modelArg)) {
        await ctx.reply(`Hmm, I don't know that model \u{1F914}\n\nAvailable: ${availableModels.join(", ")}`);
        return true;
      }

      const current = getCurrentModel();
      if (modelArg === current) {
        await ctx.reply(`Already on *${modelArg}*! \u{1F44D}`, { parse_mode: "Markdown" });
        return true;
      }

      const targetProvider = getProviderForModel(modelArg);
      const currentProvider = getAIProviderName();
      const isSwitchingProvider = targetProvider !== currentProvider;

      const switchMsg = isSwitchingProvider
        ? `Switching to *${modelArg}* (${targetProvider})... \u{1F504}\n\n(Switching provider - full session reset!)`
        : `Switching to *${modelArg}*... \u{1F504}\n\n(Session restarts, context will be cleared)`;
      await ctx.reply(switchMsg, { parse_mode: "Markdown" });

      try {
        const newProvider = await switchModel(modelArg);
        await ctx.reply(`Now using *${modelArg}*! \u{1F389} (${newProvider})`, { parse_mode: "Markdown" });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Failed to switch: ${errMsg}`);
      }
      return true;
    }

    case "tts": {
      const subArg = args.trim().toLowerCase();

      // /tts or /tts status - show current state
      if (!subArg || subArg === "status") {
        const status = getTTSOutputStatus();
        const emoji = status === "enabled" ? "\u{1F50A}" : "\u{1F507}";
        await ctx.reply(`${emoji} Voice output: *${status}*\n\nUse \`/tts on\` or \`/tts off\` to toggle!`, { parse_mode: "Markdown" });
        return true;
      }

      // /tts on - enable TTS (OpenAI cloud API)
      if (subArg === "on") {
        const success = enableTTSOutput();
        if (success) {
          await ctx.reply("\u{1F50A} Voice output: *enabled!*\n\nSend voice messages and I'll reply with voice too! \u{1F5E3}\u{FE0F}\n\n_(Powered by OpenAI)_", { parse_mode: "Markdown" });
        } else {
          await ctx.reply("Oops, couldn't enable voice output \u{1F615} Make sure OPENAI_API_KEY is set.", { parse_mode: "Markdown" });
        }
        return true;
      }

      // /tts off - disable TTS
      if (subArg === "off") {
        disableTTSOutput();
        await ctx.reply("\u{1F507} Voice output: *disabled*\n\nAll responses will be text only now!", { parse_mode: "Markdown" });
        return true;
      }

      // Invalid argument
      await ctx.reply("Usage: `/tts` (status), `/tts on`, `/tts off` \u{1F3A4}", { parse_mode: "Markdown" });
      return true;
    }

    // ============ PRODUCTIVITY COMMANDS ============

    case "todo": {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "";
      const text = parts.slice(1).join(" ");

      // No args: show button menu
      if (!subcommand) {
        const keyboard = new InlineKeyboard()
          .text("\u{2795} Add", "todo_add")
          .text("\u{1F4CB} List", "todo_list")
          .text("\u{1F5D1}\u{FE0F} Clear", "todo_clear");
        await ctx.reply("\u{1F4DD} What would you like to do?", { reply_markup: keyboard });
        return true;
      }

      const todos = loadTodos();

      switch (subcommand) {
        case "add": {
          if (!text) {
            await ctx.reply(`\u{1F4DD} *Usage:* \`/todo add [text]\``, { parse_mode: "Markdown" });
            return true;
          }
          const newTodo: TodoItem = {
            id: todos.nextId++,
            text,
            done: false,
            createdAt: new Date().toISOString(),
          };
          todos.items.push(newTodo);
          saveTodos(todos);
          await ctx.reply(`${ICONS.success} *Added todo #${newTodo.id}!*\n${escapeMarkdown(text)}`, { parse_mode: "Markdown" });
          return true;
        }

        case "done": {
          const todoId = parseInt(text, 10);
          if (isNaN(todoId)) {
            await ctx.reply(`\u{1F4DD} *Usage:* \`/todo done [id]\``, { parse_mode: "Markdown" });
            return true;
          }
          const todo = todos.items.find((t) => t.id === todoId);
          if (!todo) {
            await ctx.reply(`${ICONS.error} Hmm, can't find todo #${todoId}!`);
            return true;
          }
          todo.done = true;
          saveTodos(todos);
          await ctx.reply(`${ICONS.done} *Nice! Done:* ${escapeMarkdown(todo.text)} \u{1F389}`, { parse_mode: "Markdown" });
          return true;
        }

        case "clear": {
          const pendingCount = todos.items.filter((t) => !t.done).length;
          if (pendingCount === 0) {
            await ctx.reply("\uD83D\uDCCB All clear already! Nothing to remove \u{2728}");
            return true;
          }
          const keyboard = new InlineKeyboard()
            .text("\u2705 Yes, clear", "todo_confirm_clear")
            .text("\u274C Nevermind", "todo_cancel_clear");
          await ctx.reply(
            `\u26A0\uFE0F *Clear ${pendingCount} todo${pendingCount > 1 ? "s" : ""}?*\nThis can't be undone!`,
            { parse_mode: "Markdown", reply_markup: keyboard }
          );
          return true;
        }

        case "list":
        default: {
          const pending = todos.items.filter((t) => !t.done);
          if (pending.length === 0) {
            await ctx.reply("\uD83D\uDCCB No todos yet! Add one with /todo add [text] \u{1F4DD}");
            return true;
          }
          const list = pending
            .map((t) => `\u2610 #${t.id} ${escapeMarkdown(t.text)}`)
            .join("\n");
          await ctx.reply(`\uD83D\uDCCB *Your Todos*\n\n${list}`, { parse_mode: "Markdown" });
          return true;
        }
      }
    }

    case "note": {
      if (!args.trim()) {
        await ctx.reply(`\u{1F4DD} *Usage:* \`/note [text]\``, { parse_mode: "Markdown" });
        return true;
      }
      const notes = loadNotes();
      const newNote: NoteItem = {
        id: notes.nextId++,
        text: args.trim(),
        createdAt: new Date().toISOString(),
      };
      notes.items.push(newNote);
      saveNotes(notes);
      await ctx.reply(`${ICONS.note} Saved! (Note #${newNote.id}) \u{2728}`);
      return true;
    }

    case "notes": {
      const notesArg = args.trim().split(/\s+/)[0]?.toLowerCase() || "";
      const notes = loadNotes();

      if (notesArg === "clear") {
        if (notes.items.length === 0) {
          await ctx.reply("\uD83D\uDCCC All clear already! No notes to remove \u{2728}");
          return true;
        }
        const keyboard = new InlineKeyboard()
          .text("\u2705 Yes, clear", "notes_confirm_clear")
          .text("\u274C Nevermind", "notes_cancel_clear");
        await ctx.reply(
          `\u26A0\uFE0F *Clear ${notes.items.length} note${notes.items.length > 1 ? "s" : ""}?*\nThis can't be undone!`,
          { parse_mode: "Markdown", reply_markup: keyboard }
        );
        return true;
      }

      const recent = notes.items.slice(-10).reverse();
      if (recent.length === 0) {
        await ctx.reply("\uD83D\uDCCC No notes yet! Save one with /note [text] \u{1F4DD}");
        return true;
      }
      const list = recent
        .map((n) => {
          const date = new Date(n.createdAt);
          const timeStr = date.toLocaleString("en-GB", { timeZone: "Europe/Berlin" });
          return `#${n.id} \\[${timeStr}\\]\n${escapeMarkdown(n.text)}`;
        })
        .join("\n\n");
      await ctx.reply(`\uD83D\uDCCC *Your Notes*\n\n${list}`, { parse_mode: "Markdown" });
      return true;
    }

    case "remind": {
      const parts = args.trim().split(/\s+/);
      const timeStr = parts[0];
      const text = parts.slice(1).join(" ");

      if (!timeStr || !text) {
        await ctx.reply("\u{23F0} *Usage:* `/remind [time] [text]`\nExamples: /remind 5m call mom, /remind 1h check email", { parse_mode: "Markdown" });
        return true;
      }

      const delayMs = parseTimeString(timeStr);
      if (!delayMs) {
        await ctx.reply("Hmm, I don't understand that time format \u{1F914} Use: 30s, 5m, 1h, 1d");
        return true;
      }

      const reminders = loadReminders();
      const triggerAt = new Date(Date.now() + delayMs).toISOString();
      const newReminder: ReminderItem = {
        id: reminders.nextId++,
        text,
        triggerAt,
        userId: userId!,
        createdAt: new Date().toISOString(),
      };
      reminders.items.push(newReminder);
      saveReminders(reminders);

      await ctx.reply(`\u{23F0} Reminder saved: "${text}" in ${timeStr}!\n\n\u{1F4A1} Heads up: Reminders are saved but notifications aren't implemented yet. Use /timer for countdown alerts that actually ping you!`);
      return true;
    }

    case "timer": {
      if (!args.trim()) {
        // No args: show button menu
        const keyboard = new InlineKeyboard()
          .text("30s", "timer_30")
          .text("1m", "timer_60")
          .row()
          .text("5m", "timer_300")
          .text("10m", "timer_600")
          .row()
          .text("15m", "timer_900");
        await ctx.reply("\u23F1\uFE0F How long?", { reply_markup: keyboard });
        return true;
      }
      // Accept time strings (5m, 1h, 30s) or raw seconds
      const timerArg = args.trim();
      let seconds: number;
      const parsedMs = parseTimeString(timerArg);
      if (parsedMs !== null) {
        seconds = Math.round(parsedMs / 1000);
      } else {
        seconds = parseInt(timerArg, 10);
      }
      if (isNaN(seconds) || seconds < 1 || seconds > 3600) {
        await ctx.reply(`${ICONS.error} Timer needs to be 1-3600 seconds (or use 5m, 1h, 30s format).`);
        return true;
      }

      if (activeTimers.size >= MAX_ACTIVE_TIMERS) {
        await ctx.reply(`${ICONS.error} Too many active timers (max ${MAX_ACTIVE_TIMERS}). Wait for some to finish!`);
        return true;
      }

      const timerId = `${userId}-${Date.now()}`;
      await ctx.reply(`\u23F1\uFE0F Timer started: *${formatDuration(seconds)}* \u{1F3C3}`, { parse_mode: "Markdown" });

      const timer = setTimeout(async () => {
        try {
          await ctx.reply(`\u{1F514} *Time's up!* \u{23F1}\u{FE0F}\u{2728}`, { parse_mode: "Markdown" });
        } catch {
          // User may have blocked bot or chat unavailable
        }
        activeTimers.delete(timerId);
      }, seconds * 1000);

      activeTimers.set(timerId, timer);
      return true;
    }

    // ============ UTILITY COMMANDS ============

    case "calc": {
      if (!args.trim()) {
        await ctx.reply("Usage: /calc [expression]\nExample: /calc 2 + 2 * 3");
        return true;
      }
      const result = safeCalc(args.trim());
      const keyboard = new InlineKeyboard()
        .text("Clear", "calc_clear");
      await ctx.reply(result, { reply_markup: keyboard });
      return true;
    }

    case "random": {
      if (!args.trim()) {
        // No args: show button menu
        const keyboard = new InlineKeyboard()
          .text("1-10", "random_1_10")
          .text("1-100", "random_1_100")
          .text("1-1000", "random_1_1000");
        await ctx.reply("Pick a range:", { reply_markup: keyboard });
        return true;
      }
      const parts = args.trim().split(/\s+/);
      let min = 1;
      let max = 100;

      if (parts.length >= 2) {
        min = parseInt(parts[0], 10);
        max = parseInt(parts[1], 10);
      } else if (parts.length === 1 && parts[0]) {
        max = parseInt(parts[0], 10);
      }

      if (isNaN(min) || isNaN(max)) {
        await ctx.reply(`\u2139\uFE0F *Usage:* \`/random [min] [max]\``, { parse_mode: "Markdown" });
        return true;
      }

      if (min > max) [min, max] = [max, min];
      const result = Math.floor(Math.random() * (max - min + 1)) + min;
      await ctx.reply(`\uD83D\uDD22 *Random (${min}-${max}):* ${result}`, { parse_mode: "Markdown" });
      return true;
    }

    case "pick": {
      const options = args.split(",").map((o) => o.trim()).filter((o) => o);
      if (options.length < 2) {
        await ctx.reply("Usage: /pick option1, option2, option3, ...");
        return true;
      }
      const picked = options[Math.floor(Math.random() * options.length)];
      await ctx.reply(`I pick: ${picked}`);
      return true;
    }

    case "uuid": {
      const uuid = randomUUID();
      await ctx.reply(`\uD83D\uDD11 *UUID:* \`${uuid}\``, { parse_mode: "Markdown" });
      return true;
    }

    case "time": {
      if (!args.trim()) {
        // No args: show button menu
        const keyboard = new InlineKeyboard()
          .text("Berlin", "time_Europe/Berlin")
          .text("NYC", "time_America/New_York")
          .row()
          .text("Tokyo", "time_Asia/Tokyo")
          .text("London", "time_Europe/London")
          .row()
          .text("UTC", "time_UTC");
        await ctx.reply("\uD83D\uDD50 Pick a timezone:", { reply_markup: keyboard });
        return true;
      }
      const timezone = args.trim();
      try {
        const now = new Date();
        const timeStr = now.toLocaleString("en-GB", {
          timeZone: timezone,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZoneName: "short",
        });
        await ctx.reply(`\uD83D\uDD50 Time in ${timezone}:\n${timeStr}`);
      } catch {
        await ctx.reply(`${ICONS.error} Invalid timezone: ${timezone}`);
      }
      return true;
    }

    case "date": {
      const now = new Date();
      const dateStr = now.toLocaleDateString("en-GB", {
        timeZone: "Europe/Berlin",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const weekNumber = getWeekNumber(now);
      await ctx.reply(`\uD83D\uDCC5 ${dateStr}\nWeek ${weekNumber}`);
      return true;
    }

    // ============ CLAUDE-POWERED COMMANDS ============

    case "weather": {
      if (!args.trim()) {
        // No args: show button menu
        const keyboard = new InlineKeyboard()
          .text("Berlin", "weather_Berlin")
          .text("London", "weather_London")
          .row()
          .text("NYC", "weather_New York")
          .text("Tokyo", "weather_Tokyo");
        await ctx.reply("Pick a city:", { reply_markup: keyboard });
        return true;
      }
      const city = args.trim();
      await ctx.replyWithChatAction("typing");
      const prompt = `Give me a brief current weather summary for ${city}. Include temperature, conditions, and a short forecast. Keep it under 200 words. If you don't have real-time data, provide a helpful response about typical weather for this time of year.`;
      return await forwardToClaude(ctx, prompt);
    }

    case "define": {
      if (!args.trim()) {
        await ctx.reply("Usage: /define [word]");
        return true;
      }
      await ctx.replyWithChatAction("typing");
      const prompt = `Define the word "${args.trim()}" concisely. Include: part of speech, definition(s), and one example sentence. Keep it brief.`;
      return await forwardToClaude(ctx, prompt);
    }

    case "translate": {
      if (!args.trim()) {
        // No args: show button menu for language selection
        const keyboard = new InlineKeyboard()
          .text("Spanish", "translate_Spanish")
          .text("German", "translate_German")
          .row()
          .text("French", "translate_French")
          .text("Japanese", "translate_Japanese");
        await ctx.reply("Pick a target language, then send text:", { reply_markup: keyboard });
        return true;
      }
      const parts = args.trim().split(/\s+/);
      const targetLang = parts[0];
      const text = parts.slice(1).join(" ");

      if (!targetLang || !text) {
        await ctx.reply("Usage: /translate [language] [text]\nExample: /translate Spanish Hello, how are you?");
        return true;
      }
      await ctx.replyWithChatAction("typing");
      const prompt = `Translate the following text to ${targetLang}. Only provide the translation, nothing else:\n"${text}"`;
      return await forwardToClaude(ctx, prompt);
    }

    // ============ SYSTEM INFO COMMANDS ============

    case "disk": {
      await ctx.replyWithChatAction("typing");
      const output = safeExec("df -h /");
      await ctx.reply(`\uD83D\uDCBE *Disk Usage:*\n\`\`\`\n${output}\`\`\``, { parse_mode: "Markdown" });
      return true;
    }

    case "memory": {
      await ctx.replyWithChatAction("typing");
      // Use vm_stat and parse it for readable output
      const vmStat = safeExec("vm_stat");
      const pageSize = 16384; // macOS ARM page size
      const lines = vmStat.split("\n");
      let freePages = 0;
      let activePages = 0;
      let inactivePages = 0;
      let wiredPages = 0;
      let compressedPages = 0;

      for (const line of lines) {
        if (line.includes("Pages free:")) {
          freePages = parseInt(line.match(/\d+/)?.[0] || "0", 10);
        } else if (line.includes("Pages active:")) {
          activePages = parseInt(line.match(/\d+/)?.[0] || "0", 10);
        } else if (line.includes("Pages inactive:")) {
          inactivePages = parseInt(line.match(/\d+/)?.[0] || "0", 10);
        } else if (line.includes("Pages wired down:")) {
          wiredPages = parseInt(line.match(/\d+/)?.[0] || "0", 10);
        } else if (line.includes("Pages occupied by compressor:")) {
          compressedPages = parseInt(line.match(/\d+/)?.[0] || "0", 10);
        }
      }

      const toGB = (pages: number) => ((pages * pageSize) / (1024 * 1024 * 1024)).toFixed(2);
      const memInfo = `\uD83E\uDDE0 *Memory Usage:*
Free: ${toGB(freePages)} GB
Active: ${toGB(activePages)} GB
Inactive: ${toGB(inactivePages)} GB
Wired: ${toGB(wiredPages)} GB
Compressed: ${toGB(compressedPages)} GB`;
      await ctx.reply(memInfo, { parse_mode: "Markdown" });
      return true;
    }

    case "cpu": {
      await ctx.replyWithChatAction("typing");
      const cpuInfo = safeExec("sysctl -n machdep.cpu.brand_string");
      const coreCount = safeExec("sysctl -n hw.ncpu");
      const loadAvg = safeExec("sysctl -n vm.loadavg");
      await ctx.reply(`\u26A1 *CPU Info:*
Model: ${cpuInfo.trim()}
Cores: ${coreCount.trim()}
Load Average: ${loadAvg.trim()}`, { parse_mode: "Markdown" });
      return true;
    }

    case "battery": {
      await ctx.replyWithChatAction("typing");
      const battery = safeExec("pmset -g batt");
      await ctx.reply(`\uD83D\uDD0B *Battery Status:*\n${battery.trim()}`, { parse_mode: "Markdown" });
      return true;
    }

    // ============ FILE MANAGEMENT COMMANDS ============

    case "ls": {
      await ctx.replyWithChatAction("typing");
      const targetPath = args.trim() || homedir();
      const resolvedPath = targetPath.startsWith("~")
        ? targetPath.replace("~", homedir())
        : targetPath;
      try {
        const files = readdirSync(resolvedPath);
        const fileList = files.slice(0, 50).join("\n");
        const truncated = files.length > 50 ? `\n... and ${files.length - 50} more` : "";
        await ctx.reply(`\uD83D\uDCC1 Files in ${resolvedPath}:\n\`\`\`\n${fileList}${truncated}\`\`\``, { parse_mode: "Markdown" });
      } catch (err) {
        await ctx.reply(`${ICONS.error} ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }

    case "pwd": {
      await ctx.reply(`Working Directory: ${process.cwd()}`);
      return true;
    }

    case "cat": {
      if (!args.trim()) {
        await ctx.reply(`\u2139\uFE0F *Usage:* \`/cat [path]\``, { parse_mode: "Markdown" });
        return true;
      }
      await ctx.replyWithChatAction("typing");
      const targetPath = args.trim().startsWith("~")
        ? args.trim().replace("~", homedir())
        : args.trim();
      try {
        const content = readFileSync(targetPath, "utf-8");
        let truncated = content.length > 2000
          ? content.substring(0, 2000) + "\n... (truncated)"
          : content;
        // Escape triple backticks to prevent Markdown parse errors
        truncated = truncated.replace(/```/g, "\\`\\`\\`");
        await ctx.reply(`\`\`\`\n${truncated}\`\`\``, { parse_mode: "Markdown" });
      } catch (err) {
        await ctx.reply(`${ICONS.error} ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }

    case "find": {
      if (!args.trim()) {
        await ctx.reply(`\u2139\uFE0F *Usage:* \`/find [name]\``, { parse_mode: "Markdown" });
        return true;
      }
      await ctx.replyWithChatAction("typing");
      const searchName = args.trim();
      const searchValidation = validateShellArg(searchName, "generic");
      if (!searchValidation.ok) {
        await ctx.reply(`${ICONS.error} Invalid search term (${searchValidation.reason}).`);
        return true;
      }
      const output = safeExec(`find ${homedir()} -name "*${searchName}*" -maxdepth 5 2>/dev/null | head -20`);
      if (!output.trim()) {
        await ctx.reply(`${ICONS.warning} No files found matching "${searchName}"`);
      } else {
        await ctx.reply(`\uD83D\uDD0D Files matching "${searchName}":\n\`\`\`\n${output}\`\`\``, { parse_mode: "Markdown" });
      }
      return true;
    }

    case "size": {
      if (!args.trim()) {
        await ctx.reply(`\u2139\uFE0F *Usage:* \`/size [path]\``, { parse_mode: "Markdown" });
        return true;
      }
      await ctx.replyWithChatAction("typing");
      const targetPath = args.trim().startsWith("~")
        ? args.trim().replace("~", homedir())
        : args.trim();
      const pathValidation = validateShellArg(targetPath, "path");
      if (!pathValidation.ok) {
        await ctx.reply(`${ICONS.error} Invalid path (${pathValidation.reason}).`);
        return true;
      }
      const output = safeExec(`du -sh "${targetPath}" 2>/dev/null`);
      await ctx.reply(`\uD83D\uDCCA Size: ${output.trim()}`);
      return true;
    }

    // ============ NETWORK COMMANDS ============

    case "dns": {
      if (!args.trim()) {
        await ctx.reply(`\u2139\uFE0F *Usage:* \`/dns [domain]\``, { parse_mode: "Markdown" });
        return true;
      }
      await ctx.replyWithChatAction("typing");
      const domain = args.trim().split(/\s+/)[0]; // Take only first word for safety
      const domainValidation = validateShellArg(domain, "domain");
      if (!domainValidation.ok) {
        await ctx.reply(`${ICONS.error} Invalid domain (${domainValidation.reason}).`);
        return true;
      }
      const output = safeExec(`nslookup "${domain}" 2>&1`);
      await ctx.reply(`\uD83C\uDF10 DNS Lookup ${domain}:\n\`\`\`\n${output}\`\`\``, { parse_mode: "Markdown" });
      return true;
    }

    case "curl": {
      if (!args.trim()) {
        await ctx.reply(`\u2139\uFE0F *Usage:* \`/curl [url]\``, { parse_mode: "Markdown" });
        return true;
      }
      await ctx.replyWithChatAction("typing");
      const url = args.trim().split(/\s+/)[0]; // Take only first word for safety
      // Only allow http/https URLs
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        await ctx.reply(`${ICONS.error} Only HTTP/HTTPS URLs are allowed.`);
        return true;
      }
      if (/[;&|`$"'\\<>(){}!\n\r]/.test(url)) {
        await ctx.reply(`${ICONS.error} Invalid characters in URL.`);
        return true;
      }
      const output = safeExec(`curl -sI --connect-timeout 5 "${url}" 2>&1 | head -20`);
      await ctx.reply(`\uD83C\uDF10 Headers for ${url}:\n\`\`\`\n${output}\`\`\``, { parse_mode: "Markdown" });
      return true;
    }

    // ============ TASK SCHEDULER COMMANDS ============

    case "schedule": {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "";

      // /schedule cancel <id>
      if (subcommand === "cancel") {
        const scheduleId = parseInt(parts[1], 10);
        if (isNaN(scheduleId)) {
          await ctx.reply(`${ICONS.error} Usage: \`/schedule cancel <id>\``, { parse_mode: "Markdown" });
          return true;
        }
        const result = cancelSchedule(scheduleId, userId!);
        await ctx.reply(result.success ? `${ICONS.success} ${result.message}` : `${ICONS.error} ${result.message}`);
        return true;
      }

      // /schedule history [id]
      if (subcommand === "history") {
        const scheduleId = parseInt(parts[1], 10);
        if (isNaN(scheduleId)) {
          // Show history for all schedules
          const schedules = getSchedules(userId!);
          const withHistory = schedules.filter((s) => s.history.length > 0);
          if (withHistory.length === 0) {
            await ctx.reply("No execution history yet.");
            return true;
          }
          const summaries = withHistory.slice(0, 5).map((s) => {
            const last = s.history[s.history.length - 1];
            const icon = last.success ? "\u{2705}" : "\u{274C}";
            return `#${s.id} - ${s.history.length} runs, last: ${icon} ${new Date(last.timestamp).toLocaleString("en-GB", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" })}`;
          });
          await ctx.reply(`\u{1F4CA} *Schedule History*\n\n${summaries.join("\n")}\n\nUse \`/schedule history <id>\` for details.`, { parse_mode: "Markdown" });
          return true;
        }
        const schedule = getScheduleById(scheduleId, userId!);
        if (!schedule) {
          await ctx.reply(`${ICONS.error} Schedule #${scheduleId} not found.`);
          return true;
        }
        await ctx.reply(formatHistory(schedule));
        return true;
      }

      // /schedule (no args) - show usage
      if (!args.trim()) {
        await ctx.reply(
          `\u{1F4C5} *Task Scheduler*\n\n` +
          `Create: \`/schedule <time|cron> <task>\`\n` +
          `List: \`/schedules\`\n` +
          `Cancel: \`/schedule cancel <id>\`\n` +
          `History: \`/schedule history [id]\`\n\n` +
          `*Examples:*\n` +
          `\`/schedule 14:30 check disk space\`\n` +
          `\`/schedule 2025-03-01 09:00 run backups\`\n` +
          `\`/schedule */5 * * * * check health\`\n` +
          `\`/schedule 0 9 * * 1-5 morning briefing\``,
          { parse_mode: "Markdown" }
        );
        return true;
      }

      // /schedule <time|cron> <task> - create a new schedule
      const result = createSchedule(args.trim(), userId!);
      if ("error" in result) {
        await ctx.reply(`${ICONS.error} ${result.error}`);
        return true;
      }

      const s = result.schedule;
      const typeLabel = s.type === "cron" ? `cron \`${s.cronExpression}\`` : `once at ${new Date(s.scheduledTime!).toLocaleString("en-GB", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" })}`;
      await ctx.reply(
        `${ICONS.success} *Schedule #${s.id} created!*\nType: ${typeLabel}\nTask: ${escapeMarkdown(s.task)}`,
        { parse_mode: "Markdown" }
      );
      return true;
    }

    case "schedules": {
      const schedules = getSchedules(userId!);
      if (schedules.length === 0) {
        await ctx.reply("\u{1F4C5} No schedules yet! Create one with /schedule");
        return true;
      }
      const active = schedules.filter((s) => s.status === "active");
      const inactive = schedules.filter((s) => s.status !== "active");
      let msg = `\u{1F4C5} *Your Schedules*\n\n`;
      if (active.length > 0) {
        msg += `*Active (${active.length}):*\n` + active.map(formatSchedule).join("\n\n") + "\n\n";
      }
      if (inactive.length > 0) {
        msg += `*Completed/Cancelled (${Math.min(inactive.length, 5)}):*\n` + inactive.slice(0, 5).map(formatSchedule).join("\n\n");
      }
      await ctx.reply(msg, { parse_mode: "Markdown" });
      return true;
    }

    // ============ SELF-IMPROVEMENT COMMANDS ============

    case "health": {
      await ctx.replyWithChatAction("typing");

      const healthStats = getHealthStats();
      const uptimeMs = Date.now() - healthStats.startedAt.getTime();
      const uptimeStr = formatUptime(uptimeMs);
      const metrics = getMetrics();
      const resourceResult = await checkResources();
      const cbState = getCircuitBreakerState();
      const watchdogRunning = isWatchdogRunning();
      const errorRate = getErrorRate(10);
      const errorPatterns = getRecentErrorPatterns();

      let statusIcon = "\u{2705}"; // green check
      if (resourceResult.status === "critical") statusIcon = "\u{1F534}";
      else if (resourceResult.status === "warning") statusIcon = "\u{1F7E1}";

      const lines: string[] = [];
      lines.push(`${statusIcon} *Health Dashboard*`);
      lines.push("");
      lines.push("*System Vitals:*");
      lines.push(`  Uptime: ${uptimeStr}`);
      lines.push(`  Memory: ${resourceResult.memory.percentUsed.toFixed(1)}% (heap ${formatBytes(resourceResult.memory.heapUsed)})`);
      if (resourceResult.disk) {
        lines.push(`  Disk: ${resourceResult.disk.percentUsed.toFixed(1)}% (${formatBytes(resourceResult.disk.available)} free)`);
      }
      lines.push("");
      lines.push("*Performance:*");
      lines.push(`  Messages: ${healthStats.messagesProcessed}`);
      lines.push(`  Errors: ${healthStats.errorsCount}`);
      lines.push(`  Error rate: ${errorRate.toFixed(2)}/min`);
      lines.push(`  Valid rate: ${(metrics.validResponseRate * 100).toFixed(1)}%`);
      lines.push(`  Consecutive fails: ${metrics.consecutiveFailures}`);
      lines.push("");
      lines.push("*Session:*");
      lines.push(`  Circuit breaker: ${cbState}`);
      lines.push(`  Restarts: ${healthStats.sessionRestarts}`);
      lines.push(`  Memory resets: ${healthStats.memoryResets}`);
      lines.push("");
      lines.push("*Services:*");
      lines.push(`  Watchdog: ${watchdogRunning ? "running" : "stopped"}`);

      if (errorPatterns.length > 0) {
        lines.push("");
        lines.push("*Active Error Patterns:*");
        for (const p of errorPatterns.slice(0, 3)) {
          lines.push(`  ${p.type}: ${p.count}x`);
        }
      }

      if (resourceResult.warnings.length > 0) {
        lines.push("");
        lines.push("*Warnings:*");
        for (const w of resourceResult.warnings) {
          lines.push(`  \\[${w.status.toUpperCase()}\\] ${escapeMarkdown(w.message)}`);
        }
      }

      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return true;
    }

    case "analytics": {
      await ctx.replyWithChatAction("typing");

      const period = args.trim().toLowerCase() || "today";
      let summary;

      switch (period) {
        case "week":
          summary = getWeekStats();
          break;
        case "month":
          summary = getMonthStats();
          break;
        case "today":
        default:
          summary = getTodayStats();
          break;
      }

      const formatted = formatAnalytics(summary);
      await ctx.reply(`\u{1F4CA} *Analytics*\n\n${formatted}`, { parse_mode: "Markdown" });
      return true;
    }

    case "errors": {
      await ctx.replyWithChatAction("typing");

      const subArg = args.trim().toLowerCase() || "recent";

      if (subArg === "patterns") {
        const patternsText = formatErrorPatterns();
        const recoveryText = formatRecoveryLog();
        await ctx.reply(`\u{1F50D} *Error Analysis*\n\n\`\`\`\n${patternsText}\n\n${recoveryText}\`\`\``, { parse_mode: "Markdown" });
        return true;
      }

      // Default: recent errors summary
      const metrics = getMetrics();
      const errorRate = getErrorRate(10);
      const todayStats = getTodayStats();
      const patternsText = formatErrorPatterns();

      const lines: string[] = [];
      lines.push("*Recent Errors*");
      lines.push("");
      lines.push(`Total today: ${todayStats.totalErrors}`);
      lines.push(`Error rate: ${errorRate.toFixed(2)}/min (10 min window)`);
      lines.push(`Consecutive failures: ${metrics.consecutiveFailures}`);
      lines.push("");

      if (Object.keys(todayStats.errorsByType).length > 0) {
        lines.push("By type:");
        for (const [type, count] of Object.entries(todayStats.errorsByType)) {
          lines.push(`  ${type}: ${count}`);
        }
        lines.push("");
      }

      lines.push(patternsText);

      await ctx.reply(`\u{26A0}\u{FE0F} ${lines.join("\n")}`, { parse_mode: "Markdown" });
      return true;
    }

    // ============ SERVER MANAGEMENT COMMANDS ============

    case "sys": {
      await ctx.replyWithChatAction("typing");
      const sysOutput = systemOverview();
      await ctx.reply(`\uD83D\uDDA5 *System Overview*\n\`\`\`\n${sysOutput}\`\`\``, { parse_mode: "Markdown" });
      return true;
    }

    case "ps": {
      await ctx.replyWithChatAction("typing");
      const psFilter = args.trim() || undefined;
      const psOutput = listProcesses(psFilter);
      const psLabel = psFilter ? `Processes matching "${psFilter}"` : "Top processes";
      await ctx.reply(`\uD83D\uDD0D *${psLabel}*\n\`\`\`\n${psOutput}\`\`\``, { parse_mode: "Markdown" });
      return true;
    }

    case "kill": {
      const killPid = args.trim().split(/\s+/)[0];
      if (!killPid) {
        await ctx.reply(`\u2139\uFE0F *Usage:* \`/kill <pid>\``, { parse_mode: "Markdown" });
        return true;
      }
      if (!/^\d+$/.test(killPid)) {
        await ctx.reply(`${ICONS.error} PID must be a number.`);
        return true;
      }
      await ctx.replyWithChatAction("typing");
      const procInfo = processDetails(killPid);
      const killResult = killProcess(killPid);
      await ctx.reply(`\uD83D\uDC80 *Kill PID ${killPid}*\n\`\`\`\n${procInfo}\n${killResult}\`\`\``, { parse_mode: "Markdown" });
      return true;
    }

    case "docker": {
      const dkParts = args.trim().split(/\s+/);
      const dkSub = dkParts[0]?.toLowerCase() || "ls";
      const dkTarget = dkParts.slice(1).join(" ");

      await ctx.replyWithChatAction("typing");

      switch (dkSub) {
        case "ls":
        case "list": {
          const dkAll = dkTarget === "all" || dkTarget === "-a";
          const dkOutput = dockerList(dkAll);
          await ctx.reply(`\uD83D\uDC33 *Docker Containers${dkAll ? " (all)" : ""}*\n\`\`\`\n${dkOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "start": {
          if (!dkTarget) { await ctx.reply(`\u2139\uFE0F Usage: \`/docker start <container>\``, { parse_mode: "Markdown" }); return true; }
          const dkOutput = dockerStart(dkTarget);
          await ctx.reply(`\u25B6\uFE0F Docker start: ${dkOutput.trim()}`);
          return true;
        }
        case "stop": {
          if (!dkTarget) { await ctx.reply(`\u2139\uFE0F Usage: \`/docker stop <container>\``, { parse_mode: "Markdown" }); return true; }
          const dkOutput = dockerStop(dkTarget);
          await ctx.reply(`\u23F9\uFE0F Docker stop: ${dkOutput.trim()}`);
          return true;
        }
        case "restart": {
          if (!dkTarget) { await ctx.reply(`\u2139\uFE0F Usage: \`/docker restart <container>\``, { parse_mode: "Markdown" }); return true; }
          const dkOutput = dockerRestart(dkTarget);
          await ctx.reply(`\uD83D\uDD04 Docker restart: ${dkOutput.trim()}`);
          return true;
        }
        case "logs": {
          const dkLogParts = dkTarget.split(/\s+/);
          const dkContainer = dkLogParts[0];
          const dkLines = parseInt(dkLogParts[1], 10) || 50;
          if (!dkContainer) { await ctx.reply(`\u2139\uFE0F Usage: \`/docker logs <container> [lines]\``, { parse_mode: "Markdown" }); return true; }
          const dkOutput = dockerLogs(dkContainer, dkLines);
          await ctx.reply(`\uD83D\uDCDC *Docker logs: ${dkContainer}*\n\`\`\`\n${dkOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "stats": {
          const dkOutput = dockerStats();
          await ctx.reply(`\uD83D\uDCCA *Docker Stats*\n\`\`\`\n${dkOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "info":
        case "df": {
          const dkOutput = dockerInfo();
          await ctx.reply(`\uD83D\uDC33 *Docker System*\n\`\`\`\n${dkOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        default: {
          await ctx.reply(`\uD83D\uDC33 *Docker Commands:*
\`/docker ls\` - Running containers
\`/docker ls all\` - All containers
\`/docker start <name>\`
\`/docker stop <name>\`
\`/docker restart <name>\`
\`/docker logs <name> [lines]\`
\`/docker stats\` - Resource usage
\`/docker info\` - System disk usage`, { parse_mode: "Markdown" });
          return true;
        }
      }
    }

    case "pm2": {
      const pmParts = args.trim().split(/\s+/);
      const pmSub = pmParts[0]?.toLowerCase() || "ls";
      const pmTarget = pmParts.slice(1).join(" ");

      await ctx.replyWithChatAction("typing");

      switch (pmSub) {
        case "ls":
        case "list": {
          const pmOutput = pm2List();
          await ctx.reply(`\u2699\uFE0F *PM2 Processes*\n\`\`\`\n${pmOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "restart": {
          if (!pmTarget) { await ctx.reply(`\u2139\uFE0F Usage: \`/pm2 restart <name>\``, { parse_mode: "Markdown" }); return true; }
          const pmOutput = pm2Restart(pmTarget);
          await ctx.reply(`\uD83D\uDD04 PM2 restart:\n\`\`\`\n${pmOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "stop": {
          if (!pmTarget) { await ctx.reply(`\u2139\uFE0F Usage: \`/pm2 stop <name>\``, { parse_mode: "Markdown" }); return true; }
          const pmOutput = pm2Stop(pmTarget);
          await ctx.reply(`\u23F9\uFE0F PM2 stop:\n\`\`\`\n${pmOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "start": {
          if (!pmTarget) { await ctx.reply(`\u2139\uFE0F Usage: \`/pm2 start <name>\``, { parse_mode: "Markdown" }); return true; }
          const pmOutput = pm2Start(pmTarget);
          await ctx.reply(`\u25B6\uFE0F PM2 start:\n\`\`\`\n${pmOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "logs": {
          const pmLogParts = pmTarget.split(/\s+/);
          const pmName = pmLogParts[0];
          const pmLines = parseInt(pmLogParts[1], 10) || 30;
          if (!pmName) { await ctx.reply(`\u2139\uFE0F Usage: \`/pm2 logs <name> [lines]\``, { parse_mode: "Markdown" }); return true; }
          const pmOutput = pm2Logs(pmName, pmLines);
          await ctx.reply(`\uD83D\uDCDC *PM2 logs: ${pmName}*\n\`\`\`\n${pmOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "flush": {
          const pmOutput = pm2Flush();
          await ctx.reply(`\uD83E\uDDF9 PM2 flush: ${pmOutput.trim()}`);
          return true;
        }
        default: {
          await ctx.reply(`\u2699\uFE0F *PM2 Commands:*
\`/pm2 ls\` - List all processes
\`/pm2 restart <name>\`
\`/pm2 stop <name>\`
\`/pm2 start <name>\`
\`/pm2 logs <name> [lines]\`
\`/pm2 flush\` - Clear all logs`, { parse_mode: "Markdown" });
          return true;
        }
      }
    }

    case "brew": {
      const brParts = args.trim().split(/\s+/);
      const brSub = brParts[0]?.toLowerCase() || "help";
      const brTarget = brParts.slice(1).join(" ");

      await ctx.replyWithChatAction("typing");

      switch (brSub) {
        case "ls":
        case "list": {
          const brOutput = brewList();
          await ctx.reply(`\uD83C\uDF7A *Installed Packages*\n\`\`\`\n${brOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "outdated": {
          const brOutput = brewOutdated();
          const brLabel = brOutput.trim() ? brOutput : "Everything is up to date!";
          await ctx.reply(`\uD83C\uDF7A *Outdated Packages*\n\`\`\`\n${brLabel}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "update": {
          if (!env.TG_ENABLE_DANGEROUS_COMMANDS) {
            await ctx.reply(dangerousCommandDisabledMessage());
            return true;
          }
          const brOutput = brewUpdate();
          await ctx.reply(`\uD83C\uDF7A *Brew Update*\n\`\`\`\n${brOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "upgrade": {
          if (!env.TG_ENABLE_DANGEROUS_COMMANDS) {
            await ctx.reply(dangerousCommandDisabledMessage());
            return true;
          }
          const brOutput = brewUpgrade(brTarget || undefined);
          await ctx.reply(`\uD83C\uDF7A *Brew Upgrade${brTarget ? `: ${brTarget}` : ""}*\n\`\`\`\n${brOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        default: {
          await ctx.reply(`\uD83C\uDF7A *Brew Commands:*
\`/brew ls\` - Installed packages
\`/brew outdated\` - Outdated packages
\`/brew update\` - Update package index
\`/brew upgrade [pkg]\` - Upgrade all or one`, { parse_mode: "Markdown" });
          return true;
        }
      }
    }

    case "git": {
      const gitParts = args.trim().split(/\s+/);
      const gitSub = gitParts[0]?.toLowerCase() || "status";
      const gitRepo = gitParts[1] || undefined;

      await ctx.replyWithChatAction("typing");

      switch (gitSub) {
        case "status": {
          const gitOutput = gitStatus(gitRepo);
          await ctx.reply(`\uD83D\uDCE6 *Git Status${gitRepo ? `: ${gitRepo}` : ""}*\n\`\`\`\n${gitOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "log": {
          const gitOutput = gitLog(gitRepo);
          await ctx.reply(`\uD83D\uDCE6 *Git Log${gitRepo ? `: ${gitRepo}` : ""}*\n\`\`\`\n${gitOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "pull": {
          if (!env.TG_ENABLE_DANGEROUS_COMMANDS) {
            await ctx.reply(dangerousCommandDisabledMessage());
            return true;
          }
          const gitOutput = gitPull(gitRepo);
          await ctx.reply(`\uD83D\uDCE6 *Git Pull${gitRepo ? `: ${gitRepo}` : ""}*\n\`\`\`\n${gitOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        default: {
          await ctx.reply(`\uD83D\uDCE6 *Git Commands:*
\`/git status [repo]\`
\`/git log [repo]\`
\`/git pull [repo]\`

Known repos: gateway (default)
Or pass an absolute path.`, { parse_mode: "Markdown" });
          return true;
        }
      }
    }

    case "ports": {
      await ctx.replyWithChatAction("typing");
      const portsOutput = listeningPorts();
      await ctx.reply(`\uD83D\uDD0C *Listening Ports*\n\`\`\`\n${portsOutput}\`\`\``, { parse_mode: "Markdown" });
      return true;
    }

    case "net": {
      const netSub = args.trim().split(/\s+/)[0]?.toLowerCase() || "help";

      await ctx.replyWithChatAction("typing");

      switch (netSub) {
        case "connections": {
          const netOutput = activeConnections();
          await ctx.reply(`\uD83C\uDF10 *Active Connections*\n\`\`\`\n${netOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "ip": {
          const netOutput = externalIP();
          await ctx.reply(`\uD83C\uDF10 *External IP:* \`${netOutput.trim()}\``, { parse_mode: "Markdown" });
          return true;
        }
        case "speed": {
          await ctx.reply("\uD83C\uDF10 Running speed test... (this takes ~15s)");
          const netOutput = speedTest();
          await ctx.reply(`\uD83C\uDF10 *Speed Test*\n\`\`\`\n${netOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        default: {
          await ctx.reply(`\uD83C\uDF10 *Network Commands:*
\`/net connections\` - Active connections
\`/net ip\` - External IP address
\`/net speed\` - Speed test
\`/ports\` - Listening ports
\`/ping <host>\` - Ping a host
\`/dns <domain>\` - DNS lookup`, { parse_mode: "Markdown" });
          return true;
        }
      }
    }

    case "df": {
      await ctx.replyWithChatAction("typing");
      const dfSub = args.trim().split(/\s+/)[0]?.toLowerCase();
      if (dfSub === "clean" || dfSub === "cleanup") {
        const dfOutput = cleanupSuggestions();
        await ctx.reply(`\uD83E\uDDF9 *Cleanup Suggestions*\n\`\`\`\n${dfOutput}\`\`\``, { parse_mode: "Markdown" });
        return true;
      }
      if (dfSub === "big" || dfSub === "largest") {
        const dfPath = args.trim().split(/\s+/)[1] || homedir();
        const dfPathValidation = validateShellArg(dfPath, "path");
        if (!dfPathValidation.ok) {
          await ctx.reply(`${ICONS.error} Invalid path (${dfPathValidation.reason}).`);
          return true;
        }
        const dfOutput = largestFiles(dfPath);
        await ctx.reply(`\uD83D\uDCC2 *Largest Files*\n\`\`\`\n${dfOutput}\`\`\``, { parse_mode: "Markdown" });
        return true;
      }
      const dfOutput = diskUsageDetailed();
      await ctx.reply(`\uD83D\uDCBE *Disk Usage*\n\`\`\`\n${dfOutput}\`\`\``, { parse_mode: "Markdown" });
      return true;
    }

    case "temp": {
      await ctx.replyWithChatAction("typing");
      const tempOutput = temperatures();
      await ctx.reply(`\uD83C\uDF21 *Temperature*\n${tempOutput}`);
      return true;
    }

    case "top": {
      await ctx.replyWithChatAction("typing");
      const topOutput = safeExec("ps aux --sort=-%cpu | head -15 | awk '{printf \"%-12s %5s %5s %s\\n\", $1, $3, $4, $11}'");
      await ctx.reply(`\u26A1 *Top Processes*\n\`\`\`\n${topOutput}\`\`\``, { parse_mode: "Markdown" });
      return true;
    }

    // ============ SNIPPET COMMANDS ============

    case "snippet": {
      const snippetParts = args.trim().split(/\s+/);
      const snippetSub = snippetParts[0]?.toLowerCase() || "";

      if (!snippetSub) {
        await ctx.reply(
          `\u{1F4CE} *Snippets*\n\n` +
          `Save: \`/snippet save <name> <content>\`\n` +
          `Run: \`/snippet run <name>\`\n` +
          `Delete: \`/snippet delete <name>\`\n` +
          `List: \`/snippets\``,
          { parse_mode: "Markdown" }
        );
        return true;
      }

      switch (snippetSub) {
        case "save": {
          const sName = snippetParts[1];
          const sContent = snippetParts.slice(2).join(" ");
          if (!sName || !sContent) {
            await ctx.reply(`${ICONS.error} Usage: \`/snippet save <name> <content>\``, { parse_mode: "Markdown" });
            return true;
          }
          if (/[^a-zA-Z0-9_-]/.test(sName)) {
            await ctx.reply(`${ICONS.error} Snippet names can only contain letters, numbers, dashes, and underscores.`);
            return true;
          }
          addSnippet(sName, sContent);
          await ctx.reply(`${ICONS.success} Snippet *${escapeMarkdown(sName)}* saved!`, { parse_mode: "Markdown" });
          return true;
        }
        case "run": {
          const sName = snippetParts[1];
          if (!sName) {
            await ctx.reply(`${ICONS.error} Usage: \`/snippet run <name>\``, { parse_mode: "Markdown" });
            return true;
          }
          const snip = getSnippet(sName);
          if (!snip) {
            await ctx.reply(`${ICONS.error} Snippet "${sName}" not found. Use /snippets to see all.`);
            return true;
          }
          await ctx.replyWithChatAction("typing");
          const snipOutput = safeExec(snip.content, 3500);
          await ctx.reply(`\u{1F4BB} *Running:* \`${escapeMarkdown(snip.content)}\`\n\`\`\`\n${snipOutput}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "delete": {
          const sName = snippetParts[1];
          if (!sName) {
            await ctx.reply(`${ICONS.error} Usage: \`/snippet delete <name>\``, { parse_mode: "Markdown" });
            return true;
          }
          const snipDeleted = deleteSnippet(sName);
          if (snipDeleted) {
            await ctx.reply(`${ICONS.success} Snippet *${escapeMarkdown(sName)}* deleted.`, { parse_mode: "Markdown" });
          } else {
            await ctx.reply(`${ICONS.error} Snippet "${sName}" not found.`);
          }
          return true;
        }
        default: {
          await ctx.reply(`${ICONS.error} Unknown subcommand. Use save, run, or delete.`);
          return true;
        }
      }
    }

    case "snippets": {
      const snippetStore = loadSnippets();
      if (snippetStore.snippets.length === 0) {
        await ctx.reply("\u{1F4CE} No snippets saved yet! Use /snippet save <name> <content>");
        return true;
      }
      const snippetList = snippetStore.snippets.map((s) => {
        const preview = s.content.length > 60 ? s.content.substring(0, 60) + "..." : s.content;
        return `*${escapeMarkdown(s.name)}* - \`${escapeMarkdown(preview)}\``;
      }).join("\n");
      await ctx.reply(`\u{1F4CE} *Your Snippets*\n\n${snippetList}`, { parse_mode: "Markdown" });
      return true;
    }

    // ============ SHELL ACCESS COMMANDS ============

    case "sh": {
      if (!args.trim()) {
        await ctx.reply(`\u{1F4BB} *Usage:* \`/sh <command>\`\nExecute any shell command directly.`, { parse_mode: "Markdown" });
        return true;
      }
      if (getConfig().security.commandWarningsEnabled) {
        await ctx.reply(`${ICONS.warning} Dangerous command: direct shell execution enabled.`);
      }
      await ctx.replyWithChatAction("typing");
      const shOutput = safeExec(args.trim(), 3500);
      if (!shOutput.trim()) {
        await ctx.reply(`${ICONS.success} Command completed (no output).`);
      } else {
        await ctx.reply(`\`\`\`\n${shOutput}\`\`\``, { parse_mode: "Markdown" });
      }
      return true;
    }

    case "shlong": {
      if (!args.trim()) {
        await ctx.reply(`\u{1F4BB} *Usage:* \`/shlong <command>\`\nExecute a long-running command with streaming output.`, { parse_mode: "Markdown" });
        return true;
      }
      if (getConfig().security.commandWarningsEnabled) {
        await ctx.reply(`${ICONS.warning} Dangerous command: long-running shell execution enabled.`);
      }
      const shlongMsg = await ctx.reply(`\u{23F3} Running: \`${escapeMarkdown(args.trim().substring(0, 80))}\`...`, { parse_mode: "Markdown" });
      const shlongChatId = ctx.chat?.id;
      if (!shlongChatId) return true;

      const shlongChild = exec(args.trim(), {
        timeout: 120000, // 2 minute timeout
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, HOME: homedir() },
      });

      let shlongAccum = "";
      let shlongLastSent = "";
      let shlongTimer: NodeJS.Timeout | null = null;

      const shlongUpdate = async () => {
        if (shlongAccum === shlongLastSent) return;
        const trunc = shlongAccum.length > 3500
          ? "..." + shlongAccum.substring(shlongAccum.length - 3500)
          : shlongAccum;
        try {
          await ctx.api.editMessageText(shlongChatId, shlongMsg.message_id, `\`\`\`\n${trunc}\`\`\``, { parse_mode: "Markdown" });
          shlongLastSent = shlongAccum;
        } catch {
          // Ignore edit failures (rate limiting, etc)
        }
      };

      shlongChild.stdout?.on("data", (data: string) => {
        shlongAccum += data;
        if (!shlongTimer) {
          shlongTimer = setTimeout(async () => {
            shlongTimer = null;
            await shlongUpdate();
          }, 2000);
        }
      });

      shlongChild.stderr?.on("data", (data: string) => {
        shlongAccum += data;
      });

      shlongChild.on("close", async (code) => {
        if (shlongTimer) clearTimeout(shlongTimer);
        shlongAccum += `\n\n[exit: ${code ?? "killed"}]`;
        await shlongUpdate();
      });

      return true;
    }

    // ============ FILE TRANSFER COMMANDS ============

    case "upload": {
      const replyMsg = ctx.message?.reply_to_message;
      const uploadDoc = replyMsg?.document;
      if (!uploadDoc) {
        await ctx.reply(`\u{1F4E4} *Usage:* Reply to a file with \`/upload [path]\`\nDownloads the file to the specified path on this machine.`, { parse_mode: "Markdown" });
        return true;
      }

      const uploadDir = args.trim() || homedir();
      const resolvedUploadDir = uploadDir.startsWith("~") ? uploadDir.replace("~", homedir()) : uploadDir;
      const uploadValidation = validateShellArg(resolvedUploadDir, "path");
      if (!uploadValidation.ok) {
        await ctx.reply(`${ICONS.error} Invalid upload path (${uploadValidation.reason}).`);
        return true;
      }

      if (!existsSync(resolvedUploadDir)) {
        try {
          mkdirSync(resolvedUploadDir, { recursive: true });
        } catch (err) {
          await ctx.reply(`${ICONS.error} Cannot create directory: ${err instanceof Error ? err.message : String(err)}`);
          return true;
        }
      }

      await ctx.replyWithChatAction("typing");
      try {
        const uploadFile = await ctx.api.getFile(uploadDoc.file_id);
        if (!uploadFile.file_path) {
          await ctx.reply(`${ICONS.error} Telegram didn't provide a download link.`);
          return true;
        }

        const uploadFileName = uploadDoc.file_name || `file_${Date.now()}`;
        const uploadDest = join(resolvedUploadDir, uploadFileName);
        const uploadUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${uploadFile.file_path}`;

        const uploadResp = await fetch(uploadUrl);
        if (!uploadResp.ok || !uploadResp.body) {
          await ctx.reply(`${ICONS.error} Download failed: HTTP ${uploadResp.status}`);
          return true;
        }

        const uploadWriter = createWriteStream(uploadDest);
        const uploadReader = uploadResp.body.getReader();
        let uploadDone = false;
        while (!uploadDone) {
          const { value, done: d } = await uploadReader.read();
          uploadDone = d;
          if (value) uploadWriter.write(Buffer.from(value));
        }
        uploadWriter.end();

        await new Promise<void>((resolve, reject) => {
          uploadWriter.on("finish", resolve);
          uploadWriter.on("error", reject);
        });

        const uploadSize = statSync(uploadDest).size;
        const uploadSizeMB = (uploadSize / 1024 / 1024).toFixed(2);
        await ctx.reply(`${ICONS.success} *File saved!*\nPath: \`${uploadDest}\`\nSize: ${uploadSizeMB} MB`, { parse_mode: "Markdown" });
      } catch (err) {
        await ctx.reply(`${ICONS.error} Upload failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }

    case "tree": {
      await ctx.replyWithChatAction("typing");
      const treeParts = args.trim().split(/\s+/);
      let treePath = treeParts[0] || ".";
      const treeDepth = treeParts[1] ? parseInt(treeParts[1], 10) : 3;

      if (treePath.startsWith("~")) {
        treePath = treePath.replace("~", homedir());
      }

      const treePathValidation = validateShellArg(treePath, "path");
      if (!treePathValidation.ok) {
        await ctx.reply(`${ICONS.error} Invalid path (${treePathValidation.reason}).`);
        return true;
      }

      const treeDepthClamped = Math.min(Math.max(treeDepth, 1), 6);
      const treeOutput = safeExec(`find "${treePath}" -maxdepth ${treeDepthClamped} -print 2>/dev/null | head -80 | sort`, 3500);
      if (!treeOutput.trim()) {
        await ctx.reply(`${ICONS.error} Path not found or empty: ${treePath}`);
      } else {
        const treeLines = treeOutput.trim().split("\n");
        const treeBase = treeLines[0] || treePath;
        const treeFormatted = treeLines.map((line) => {
          const rel = line.replace(treeBase, "").replace(/^\//, "");
          if (!rel) return basename(treeBase) + "/";
          const d = rel.split("/").length - 1;
          return "  ".repeat(d) + basename(rel);
        }).join("\n");
        const treeTruncated = treeFormatted.length > 3500 ? treeFormatted.substring(0, 3500) + "\n... (truncated)" : treeFormatted;
        await ctx.reply(`\u{1F332} *Tree:* \`${escapeMarkdown(treePath)}\`\n\`\`\`\n${treeTruncated}\`\`\``, { parse_mode: "Markdown" });
      }
      return true;
    }

    // ============ SESSION MANAGEMENT COMMANDS ============

    case "session": {
      const sessionSub = args.trim().toLowerCase();

      if (!sessionSub) {
        const sessionKb = new InlineKeyboard()
          .text("\u{1F4CA} Status", "session_status")
          .text("\u{1F480} Kill", "session_kill")
          .row()
          .text("\u{1F195} New Session", "session_new");
        await ctx.reply(`\u{1F5A5} *Session Management*\n\nWhat would you like to do?`, {
          parse_mode: "Markdown",
          reply_markup: sessionKb,
        });
        return true;
      }

      if (sessionSub === "kill") {
        await ctx.reply("\u{1F480} Force killing current session...");
        stopSession();
        const sessionProvCfg = getProviderProcessConfig(getConfiguredProviderName(), {
          mcpConfigPath: getConfig().mcpConfigPath,
        });
        if (sessionProvCfg.clearSessionProcessPattern) {
          safeExec(`pkill -KILL -f '${sessionProvCfg.clearSessionProcessPattern}' 2>/dev/null || true`);
        }
        await ctx.reply(`${ICONS.success} Session killed. Use /session new to start a fresh one.`);
        return true;
      }

      if (sessionSub === "new") {
        await ctx.reply("\u{1F504} Starting fresh session...");
        stopSession();
        await new Promise(resolve => setTimeout(resolve, 500));
        await restartSession();
        await ctx.reply(`${ICONS.success} New session started!`);
        return true;
      }

      // Default: show session status
      const sessStats = getAIStats();
      const sessIsAlive = isSessionAlive();
      const sessCB = getCircuitBreakerState();
      const sessSID = getSessionId();
      const sessModelName = getCurrentModel();

      let sessInfo = `\u{1F5A5} *Session Status*\n\n`;
      sessInfo += `ID: \`${sessSID}\`\n`;
      sessInfo += `Model: *${sessModelName}*\n`;
      sessInfo += `Alive: ${sessIsAlive ? ICONS.success : ICONS.error}\n`;
      sessInfo += `Circuit Breaker: ${sessCB}\n`;

      if (sessStats) {
        sessInfo += `Messages: ${sessStats.messageCount}\n`;
        sessInfo += `Session Uptime: ${formatUptime(sessStats.durationSeconds * 1000)}\n`;
        sessInfo += `Failures: ${sessStats.recentFailures}\n`;
        sessInfo += `Healthy: ${sessStats.isHealthy ? ICONS.success : ICONS.error}`;
      }

      await ctx.reply(sessInfo, { parse_mode: "Markdown" });
      return true;
    }

    case "sessions": {
      const allSessStats = getAIStats();
      const allSessAlive = isSessionAlive();
      const allSessCB = getCircuitBreakerState();
      const allSessSID = getSessionId();
      const allSessModel = getCurrentModel();

      let allSessInfo = `\u{1F5A5} *Active Sessions*\n\n`;
      allSessInfo += `*Current:*\n`;
      allSessInfo += `  ID: \`${allSessSID}\`\n`;
      allSessInfo += `  Model: *${allSessModel}*\n`;
      allSessInfo += `  Status: ${allSessAlive ? "Running " + ICONS.success : "Down " + ICONS.error}\n`;
      allSessInfo += `  Circuit Breaker: ${allSessCB}\n`;

      if (allSessStats) {
        allSessInfo += `  Messages: ${allSessStats.messageCount}\n`;
        allSessInfo += `  Uptime: ${formatUptime(allSessStats.durationSeconds * 1000)}\n`;
      }

      await ctx.reply(allSessInfo, { parse_mode: "Markdown" });
      return true;
    }

    case "context": {
      const ctxStats = getAIStats();
      const ctxModel = getCurrentModel();
      const ctxStart = getStartTime();
      const ctxUptime = formatUptime(Date.now() - ctxStart.getTime());

      let ctxText = `\u{1F4CA} *Current Context*\n\n`;
      ctxText += `Model: *${ctxModel}*\n`;
      ctxText += `Provider: ${providerName}\n`;
      ctxText += `Bot Uptime: ${ctxUptime}\n`;

      if (ctxStats) {
        ctxText += `Session ID: \`${ctxStats.sessionId}\`\n`;
        ctxText += `Session Uptime: ${formatUptime(ctxStats.durationSeconds * 1000)}\n`;
        ctxText += `Messages This Session: ${ctxStats.messageCount}\n`;
        ctxText += `Recent Failures: ${ctxStats.recentFailures}\n`;
        ctxText += `Health: ${ctxStats.isHealthy ? "Good " + ICONS.success : "Degraded " + ICONS.warning}`;
      }

      await ctx.reply(ctxText, { parse_mode: "Markdown" });
      return true;
    }

    // ============ NOTIFICATION PREFERENCE COMMANDS ============

    case "quiet": {
      const nowQuiet = toggleQuietMode();
      if (nowQuiet) {
        await ctx.reply("\u{1F507} *Quiet mode: ON*\nNon-critical notifications suppressed.", { parse_mode: "Markdown" });
      } else {
        await ctx.reply("\u{1F50A} *Quiet mode: OFF*\nAll notifications enabled.", { parse_mode: "Markdown" });
      }
      return true;
    }

    case "dnd": {
      if (!args.trim()) {
        const dndRemaining = getDNDRemaining();
        if (dndRemaining !== null) {
          const dndMins = Math.ceil(dndRemaining / 60000);
          await ctx.reply(`\u{1F6D1} *DND active* - ${dndMins} min remaining.\nUse \`/dnd off\` to cancel.`, { parse_mode: "Markdown" });
        } else {
          await ctx.reply(`\u{1F514} *DND is off.*\nUse \`/dnd <duration>\` to enable.\nExamples: /dnd 30m, /dnd 2h`, { parse_mode: "Markdown" });
        }
        return true;
      }

      if (args.trim().toLowerCase() === "off") {
        clearDND();
        await ctx.reply(`${ICONS.success} DND disabled. Notifications are back on.`);
        return true;
      }

      const dndDuration = parseTimeString(args.trim());
      if (!dndDuration) {
        await ctx.reply(`${ICONS.error} Invalid duration. Use: 30m, 1h, 2h, etc.`);
        return true;
      }

      const dndUntilStr = setDND(dndDuration);
      const dndDisplay = new Date(dndUntilStr).toLocaleString("en-GB", { timeZone: "Europe/Berlin", timeStyle: "short" });
      await ctx.reply(`\u{1F6D1} *Do Not Disturb* enabled until ${dndDisplay}`, { parse_mode: "Markdown" });
      return true;
    }

    // ============ DEPLOY ============

    case "deploy": {
      const sub = args.trim().toLowerCase();

      if (sub === "status") {
        const state = getDeployState();
        const lines = [
          `Deploy status: ${state.status}`,
          state.startedAt ? `Started: ${state.startedAt}` : null,
          state.previousCommit ? `Previous: ${state.previousCommit.slice(0, 8)}` : null,
          state.currentCommit ? `Current: ${state.currentCommit.slice(0, 8)}` : null,
          state.phase ? `Phase: ${state.phase}` : null,
          state.initiatedBy ? `Initiated by: ${state.initiatedBy}` : null,
        ].filter(Boolean);
        await ctx.reply(lines.join("\n"));
        return true;
      }

      if (sub === "rollback") {
        await ctx.replyWithChatAction("typing");
        const result = await manualRollback();
        if (result.success) {
          await ctx.reply(`${ICONS.success} ${result.message}\nRestarting PM2 app: ${env.TG_PM2_APP_NAME}...`);
          const { execSync } = require("child_process");
          execSync(`pm2 restart "${env.TG_PM2_APP_NAME}"`, { encoding: "utf-8" });
        } else {
          await ctx.reply(`${ICONS.error} ${result.message}${result.output ? "\n" + result.output : ""}`);
        }
        return true;
      }

      // Default: execute deploy
      const state = getDeployState();
      if (state.status !== "idle") {
        await ctx.reply(`Deploy already in progress (${state.phase || state.status}). Started ${state.startedAt || "unknown"}.`);
        return true;
      }

      await ctx.reply("Starting deploy pipeline...");
      const result = await executeDeploy("command", getInFlightCount);

      if (!result.success) {
        await ctx.reply(`${ICONS.error} Deploy failed at ${result.phase || "unknown"}\n${result.output || result.message}`);
      }
      // If successful, the process restarts and we never reach here
      return true;
    }

    // ============ SYSTEM SHORTCUT COMMANDS ============

    case "reboot": {
      if (getConfig().security.commandWarningsEnabled) {
        await ctx.reply(`${ICONS.warning} Dangerous command: this will reboot the host.`);
      }
      const rebootKb = new InlineKeyboard()
        .text("\u{2705} Yes, reboot", "reboot_confirm")
        .text("\u{274C} Cancel", "reboot_cancel");
      await ctx.reply(`\u{26A0}\u{FE0F} *Reboot the host machine?*\nThis will disconnect all services temporarily.`, {
        parse_mode: "Markdown",
        reply_markup: rebootKb,
      });
      return true;
    }

    case "sleep": {
      if (getConfig().security.commandWarningsEnabled) {
        await ctx.reply(`${ICONS.warning} Dangerous command: this will suspend the host.`);
      }
      const sleepKb = new InlineKeyboard()
        .text("\u{2705} Yes, sleep", "sleep_confirm")
        .text("\u{274C} Cancel", "sleep_cancel");
      await ctx.reply(`\u{1F4A4} *Put host machine to sleep?*\nAll services will be interrupted.`, {
        parse_mode: "Markdown",
        reply_markup: sleepKb,
      });
      return true;
    }

    case "wake": {
      await ctx.reply(`${ICONS.warning} Wake on LAN requires hardware support and network config.\nIf the host machine is sleeping, it should auto-wake on SSH or network activity if "Wake for network access" is enabled in System Settings > Energy.`);
      return true;
    }

    case "screenshot": {
      await ctx.replyWithChatAction("typing");
      const screenshotPath = `/tmp/screenshot_${Date.now()}.png`;
      const screenshotOut = safeExec(`screencapture -x "${screenshotPath}" 2>&1`);
      if (existsSync(screenshotPath)) {
        try {
          await ctx.replyWithPhoto(new InputFile(screenshotPath), { caption: "Screenshot" });
          safeExec(`rm -f "${screenshotPath}"`);
        } catch (err) {
          await ctx.reply(`${ICONS.error} Failed to send screenshot: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        await ctx.reply(`${ICONS.error} Screenshot failed. ${screenshotOut.trim()}\nNote: screencapture requires a display session.`);
      }
      return true;
    }

    default:
      return false;
  }
  } catch (err) {
    logError("commands", "command_handler_failed", {
      command,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await ctx.reply(`${ICONS.error} An error occurred processing /${command}.`);
    } catch {
      // Ignore reply failure
    }
    return true;
  }
}
