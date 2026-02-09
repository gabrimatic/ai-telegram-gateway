/**
 * Callback handlers for inline keyboard buttons
 */

import { Context, InlineKeyboard, CallbackQueryContext } from "grammy";
import { runAI, getStats as getAIStats, getCurrentModel, restartSession, stopSession, getSessionId, isSessionAlive, getCircuitBreakerState, switchModel, getAvailableModels } from "./ai";
import { getConfig, ModelName } from "./config";
import { error } from "./logger";
import { incrementMessages, incrementErrors } from "./health";
import { recordSuccess, recordFailure } from "./metrics";
import { buildSystemPrompt, wrapWithSystemPrompt, SessionContext } from "./system-prompt";
import { loadMemoryContext } from "./memory";
import { getConfiguredProviderName, getProviderDisplayName, getProviderProcessConfig } from "./provider";
import { ICONS } from "./constants";
import { loadTodos, saveTodos, loadNotes, saveNotes } from "./storage";
import { formatDuration, formatUptime, escapeMarkdown, safeExec } from "./utils";
import { activeTimers } from "./commands";
import { env } from "./env";

export async function handleTodoCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    const action = ctx.callbackQuery.data.replace("todo_", "");
    const todos = loadTodos();

    switch (action) {
      case "add": {
        await ctx.editMessageText("Reply to this message with your todo text.\n\nOr use: /todo add [text]");
        break;
      }
      case "list": {
        const pending = todos.items.filter((t) => !t.done);
        if (pending.length === 0) {
          await ctx.editMessageText("\uD83D\uDCCB No pending todos. Use /todo add [text] to add one.");
        } else {
          const list = pending.map((t) => `\u2610 #${t.id} ${escapeMarkdown(t.text)}`).join("\n");
          await ctx.editMessageText(`\uD83D\uDCCB *Pending Todos*\n\n${list}`, { parse_mode: "Markdown" });
        }
        break;
      }
      case "clear": {
        const pendingCount = todos.items.filter((t) => !t.done).length;
        if (pendingCount === 0) {
          await ctx.editMessageText("\uD83D\uDCCB No todos to clear.");
        } else {
          const keyboard = new InlineKeyboard()
            .text("\u2705 Yes, clear", "todo_confirm_clear")
            .text("\u274C Cancel", "todo_cancel_clear");
          await ctx.editMessageText(
            `\u26A0\uFE0F *Clear ${pendingCount} todo${pendingCount > 1 ? "s" : ""}?*\nThis cannot be undone.`,
            { parse_mode: "Markdown", reply_markup: keyboard }
          );
        }
        break;
      }
    }
  } catch (err) {
    error("callbacks", "todo_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleTimerCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    const match = ctx.callbackQuery.data.match(/^timer_(\d+)$/);
    if (!match) return;
    const seconds = parseInt(match[1], 10);
    const userId = ctx.from?.id?.toString();

    if (activeTimers.size >= 20) {
      await ctx.answerCallbackQuery("Too many active timers!");
      return;
    }

    const timerId = `${userId}-${Date.now()}`;
    await ctx.editMessageText(`\u23F1\uFE0F Timer: *${formatDuration(seconds)}*`, { parse_mode: "Markdown" });

    const timer = setTimeout(async () => {
      try {
        await ctx.reply(`\u23F1\uFE0F\u2705 *Time's up!*`, { parse_mode: "Markdown" });
      } catch {
        // User may have blocked bot or chat unavailable
      }
      activeTimers.delete(timerId);
    }, seconds * 1000);

    activeTimers.set(timerId, timer);
  } catch (err) {
    error("callbacks", "timer_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleRandomCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    const match = ctx.callbackQuery.data.match(/^random_(\d+)_(\d+)$/);
    if (!match) return;
    const min = parseInt(match[1], 10);
    const max = parseInt(match[2], 10);
    const result = Math.floor(Math.random() * (max - min + 1)) + min;

    await ctx.editMessageText(`\uD83D\uDD22 *Random (${min}-${max}):* ${result}`, { parse_mode: "Markdown" });
  } catch (err) {
    error("callbacks", "random_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleTimeCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    const timezone = ctx.callbackQuery.data.replace("time_", "");
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
      await ctx.editMessageText(`\uD83D\uDD50 Time in ${timezone}:\n${timeStr}`);
    } catch {
      await ctx.editMessageText(`${ICONS.error} Invalid timezone: ${timezone}`);
    }
  } catch (err) {
    error("callbacks", "time_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleWeatherCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  const city = ctx.callbackQuery.data.replace("weather_", "");
  await ctx.answerCallbackQuery("Fetching weather...");

  const prompt = `Give me a brief current weather summary for ${city}. Include temperature, conditions, and a short forecast. Keep it under 200 words. If you don't have real-time data, provide a helpful response about typical weather for this time of year.`;

  try {
    const config = getConfig();
    let finalPrompt = prompt;

    if (config.enableSystemPrompt) {
      const stats = getAIStats();
      const context: SessionContext = {
        messageCount: stats?.messageCount ?? 0,
        recentFailures: stats?.recentFailures ?? 0,
      };
      const memoryContext = loadMemoryContext();
      const systemPrompt = buildSystemPrompt(context, memoryContext);
      finalPrompt = wrapWithSystemPrompt(systemPrompt, prompt);
    }

    const result = await runAI(finalPrompt);
    incrementMessages();

    if (result.success && result.response.trim()) {
      recordSuccess();
      const keyboard = new InlineKeyboard()
        .text("\uD83D\uDD04 Refresh", `weather_${city}`)
        .text("\uD83C\uDF0D Other City", "weather_menu");
      await ctx.editMessageText(result.response.trim(), { reply_markup: keyboard });
    } else {
      recordFailure("unknown");
      await ctx.editMessageText(`${ICONS.error} Sorry, I couldn't get weather info.`);
    }
  } catch (err) {
    incrementErrors();
    error("callbacks", "weather_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.editMessageText(`${ICONS.error} An error occurred fetching weather.`);
  }
}

export async function handleTranslateCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    const lang = ctx.callbackQuery.data.replace("translate_", "");
    await ctx.editMessageText(`Language set to ${lang}. Now use:\n/translate ${lang} [your text]`);
  } catch (err) {
    error("callbacks", "translate_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleCalcCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    await ctx.editMessageText("Calculator cleared. Use /calc [expression]");
  } catch (err) {
    error("callbacks", "calc_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleHelpCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    const providerName = getProviderDisplayName();
    const helpText = `\uD83E\uDD16 *Bot Commands*

\uD83D\uDCCB *PRODUCTIVITY*
/todo - Manage tasks
/note /notes - Quick notes
/remind - Reminders
/timer - Countdown
/schedule /schedules - Task scheduler
/snippet /snippets - Command bookmarks

\uD83D\uDD27 *UTILITIES*
/calc - Calculator
/random /pick
/uuid /time /date

\uD83C\uDF10 *INFO* _(${providerName}-powered)_
/weather /define /translate

\uD83D\uDCBB *SYSTEM & SESSION*
/model - Switch AI model
/tts - Toggle voice output
/clear - Fresh start
/session /context
/disk /memory /cpu /battery

\uD83D\uDDA5 *SERVER*
/sys /docker /pm2 /brew /git
/kill /ports /net /ps /df /top /temp
/reboot /sleep /screenshot

\uD83D\uDCE6 *SHELL & FILES*
/sh /shlong - Shell access
/ls /pwd /cat /find /size /tree /upload

\uD83C\uDF10 *NETWORK*
/ping /dns /curl

\uD83D\uDD14 *NOTIFICATIONS*
/quiet /dnd

\uD83D\uDCC8 *MONITORING*
/health /analytics /errors

\u2139\uFE0F /help /stats /id /version /uptime`;
    await ctx.editMessageText(helpText, { parse_mode: "Markdown" });
  } catch (err) {
    error("callbacks", "help_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleWeatherMenuCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    const keyboard = new InlineKeyboard()
      .text("Berlin", "weather_Berlin")
      .text("London", "weather_London")
      .row()
      .text("NYC", "weather_New York")
      .text("Tokyo", "weather_Tokyo");
    await ctx.editMessageText("\uD83C\uDF24\uFE0F Pick a city:", { reply_markup: keyboard });
  } catch (err) {
    error("callbacks", "weather_menu_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleTimerMenuCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    const keyboard = new InlineKeyboard()
      .text("30s", "timer_30")
      .text("1m", "timer_60")
      .row()
      .text("5m", "timer_300")
      .text("10m", "timer_600")
      .row()
      .text("15m", "timer_900");
    await ctx.editMessageText("\u23F1\uFE0F Pick duration:", { reply_markup: keyboard });
  } catch (err) {
    error("callbacks", "timer_menu_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleNotesListCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    const notes = loadNotes();
    const recent = notes.items.slice(-10).reverse();
    if (recent.length === 0) {
      await ctx.editMessageText("\uD83D\uDCCC No notes yet. Use /note [text] to save one.");
    } else {
      const list = recent.map((n) => {
        const date = new Date(n.createdAt);
        const timeStr = date.toLocaleString("en-GB", { timeZone: "Europe/Berlin" });
        return `#${n.id} \\[${timeStr}\\]\n${escapeMarkdown(n.text)}`;
      }).join("\n\n");
      await ctx.editMessageText(`\uD83D\uDCCC *Recent Notes*\n\n${list}`, { parse_mode: "Markdown" });
    }
  } catch (err) {
    error("callbacks", "notes_list_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleTodoConfirmClearCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    const todos = loadTodos();
    const count = todos.items.filter((t) => !t.done).length;
    todos.items = [];
    todos.nextId = 1;
    saveTodos(todos);
    await ctx.editMessageText(`${ICONS.clear} Cleared ${count} todo${count !== 1 ? "s" : ""}.`);
  } catch (err) {
    error("callbacks", "todo_confirm_clear_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleTodoCancelClearCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    await ctx.editMessageText("\u274C Cancelled.");
  } catch (err) {
    error("callbacks", "todo_cancel_clear_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleNotesConfirmClearCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    const notes = loadNotes();
    const count = notes.items.length;
    notes.items = [];
    notes.nextId = 1;
    saveNotes(notes);
    await ctx.editMessageText(`${ICONS.clear} Cleared ${count} note${count !== 1 ? "s" : ""}.`);
  } catch (err) {
    error("callbacks", "notes_confirm_clear_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleNotesCancelClearCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    await ctx.editMessageText("\u274C Cancelled.");
  } catch (err) {
    error("callbacks", "notes_cancel_clear_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleModelCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  const modelArg = ctx.callbackQuery.data.replace("model_", "") as ModelName;
  const availableModels = getAvailableModels();

  if (!availableModels.includes(modelArg)) {
    await ctx.answerCallbackQuery("Invalid model");
    return;
  }

  const current = getCurrentModel();
  if (modelArg === current) {
    await ctx.answerCallbackQuery(`Already using ${modelArg}`);
    return;
  }

  await ctx.answerCallbackQuery(`Switching to ${modelArg}...`);
  try {
    await ctx.editMessageText(`Switching to *${modelArg}*...\n\n_Session will restart_`, { parse_mode: "Markdown" });
    const newProvider = await switchModel(modelArg);
    await ctx.editMessageText(`Now using *${modelArg}* (${newProvider})\n\n_Fresh session started_`, { parse_mode: "Markdown" });
  } catch (err) {
    error("callbacks", "model_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await ctx.editMessageText(`Failed to switch model: ${err instanceof Error ? err.message : String(err)}`);
    } catch { /* ignore */ }
  }
}

// ============ SESSION MANAGEMENT CALLBACKS ============

export async function handleSessionCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  const action = ctx.callbackQuery.data.replace("session_", "");
  try {
    switch (action) {
      case "status": {
        const stats = getAIStats();
        const alive = isSessionAlive();
        const cbState = getCircuitBreakerState();
        const sessionId = getSessionId();
        const model = getCurrentModel();

        let status = `*Session Status*\n\n`;
        status += `ID: \`${sessionId}\`\n`;
        status += `Model: *${model}*\n`;
        status += `Alive: ${alive ? ICONS.success : ICONS.error}\n`;
        status += `Circuit Breaker: ${cbState}\n`;

        if (stats) {
          status += `Messages: ${stats.messageCount}\n`;
          status += `Uptime: ${formatUptime(stats.durationSeconds * 1000)}\n`;
          status += `Failures: ${stats.recentFailures}\n`;
          status += `Healthy: ${stats.isHealthy ? ICONS.success : ICONS.error}`;
        }

        await ctx.editMessageText(status, { parse_mode: "Markdown" });
        break;
      }
      case "kill": {
        await ctx.editMessageText("Force killing session...");
        stopSession();
        const providerConfig = getProviderProcessConfig(getConfiguredProviderName(), {
          mcpConfigPath: getConfig().mcpConfigPath,
        });
        if (providerConfig.clearSessionProcessPattern) {
          safeExec(`pkill -KILL -f '${providerConfig.clearSessionProcessPattern}' 2>/dev/null || true`);
        }
        await ctx.editMessageText(`${ICONS.success} Session killed. Use /session new to start a fresh one.`);
        break;
      }
      case "new": {
        await ctx.editMessageText("Starting fresh session...");
        stopSession();
        await new Promise(resolve => setTimeout(resolve, 500));
        await restartSession();
        await ctx.editMessageText(`${ICONS.success} New session started!`);
        break;
      }
    }
  } catch (err) {
    error("callbacks", "session_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

// ============ SYSTEM SHORTCUT CALLBACKS ============

export async function handleRebootConfirmCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    if (!env.TG_ENABLE_DANGEROUS_COMMANDS) {
      await ctx.editMessageText(`${ICONS.warning} This operation is disabled by configuration.`);
      await ctx.answerCallbackQuery("Disabled");
      return;
    }
    await ctx.editMessageText("Rebooting host machine in 5 seconds...");
    await ctx.answerCallbackQuery("Rebooting...");
    // Give time for the message to send before reboot
    setTimeout(() => {
      safeExec("sudo shutdown -r +0 2>/dev/null || sudo reboot 2>/dev/null || osascript -e 'tell app \"System Events\" to restart'");
    }, 5000);
  } catch (err) {
    error("callbacks", "reboot_confirm_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.answerCallbackQuery();
  }
}

export async function handleRebootCancelCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    await ctx.editMessageText("\u{274C} Reboot cancelled.");
  } catch (err) {
    error("callbacks", "reboot_cancel_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleSleepConfirmCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    if (!env.TG_ENABLE_DANGEROUS_COMMANDS) {
      await ctx.editMessageText(`${ICONS.warning} This operation is disabled by configuration.`);
      await ctx.answerCallbackQuery("Disabled");
      return;
    }
    await ctx.editMessageText("Putting host machine to sleep...");
    await ctx.answerCallbackQuery("Sleeping...");
    setTimeout(() => {
      safeExec("pmset sleepnow 2>/dev/null || osascript -e 'tell app \"System Events\" to sleep'");
    }, 2000);
  } catch (err) {
    error("callbacks", "sleep_confirm_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.answerCallbackQuery();
  }
}

export async function handleSleepCancelCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    await ctx.editMessageText("\u{274C} Sleep cancelled.");
  } catch (err) {
    error("callbacks", "sleep_cancel_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}
