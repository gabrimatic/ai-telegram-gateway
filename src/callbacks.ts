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
import { getConfiguredProviderName, getProviderProcessConfig } from "./provider";
import { ICONS } from "./constants";
import { formatDuration, formatUptime, safeExec } from "./utils";
import { loadSchedules, saveSchedules, reloadSchedules } from "./task-scheduler";
import { env } from "./env";

export async function handleTimerCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    const match = ctx.callbackQuery.data.match(/^timer_(\d+)$/);
    if (!match) return;
    const seconds = parseInt(match[1], 10);
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const triggerAt = new Date(Date.now() + seconds * 1000).toISOString();
    const label = `Timer ${formatDuration(seconds)}`;
    const store = loadSchedules();
    const id = store.nextId++;
    store.schedules.push({
      id,
      type: "once",
      jobType: "shell",
      task: `echo "${label} done!"`,
      output: "telegram",
      name: label,
      status: "active",
      createdAt: new Date().toISOString(),
      scheduledTime: triggerAt,
      nextRun: triggerAt,
      userId,
      history: [],
    });
    saveSchedules(store);
    reloadSchedules();

    await ctx.editMessageText(`\u23F1\uFE0F Timer: *${formatDuration(seconds)}* (schedule #${id})`, { parse_mode: "Markdown" });
  } catch (err) {
    error("callbacks", "timer_callback_failed", {
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

export async function handleHelpCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    const helpText = `\uD83E\uDD16 *Bot Commands*

\uD83D\uDCCB *PRODUCTIVITY*
/schedule - Scheduled tasks
/timer - Quick countdown

\uD83C\uDF10 *INFO*
/weather /define /translate

\uD83D\uDCBB *SYSTEM & SESSION*
/model /tts /clear
/session - Session status & management
/disk /memory /cpu /battery /temp

\uD83D\uDDA5 *SERVER*
/pm2 /git /net /sh
/ps /kill /top /reboot

\uD83D\uDCC1 *FILES*
/cd /ls /pwd /cat /find /size

\uD83D\uDCC8 *MONITORING*
/health /analytics /errors

\u2139\uFE0F /help /stats /id /version /uptime /ping`;
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

