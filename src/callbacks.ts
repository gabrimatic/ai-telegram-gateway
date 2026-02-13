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
import { formatDuration, formatUptime, safeExec } from "./utils";
import {
  cancelSchedule,
  createSchedule,
  disableRandomCheckins,
  enableRandomCheckins,
  regenerateRandomCheckinsForToday,
  reloadSchedules,
} from "./task-scheduler";
import { env } from "./env";
import { loadAllowlist, isAdminUser, isUserAllowed } from "./storage";
import {
  buildHelpKeyboard,
  buildHelpText,
  buildCommandCenterView,
  getCommandCenterSection,
  handleCommand,
} from "./commands";
import { StreamingResponseHandler, sendErrorResponse } from "./response-handler";
import {
  getActionContext,
  createActionContext,
  buildActionPrompt,
  buildActionKeyboard,
} from "./interactive-actions";
import { buildResponseContextLabel } from "./response-context";
import {
  buildScheduleHomeView,
  buildScheduleListView,
  buildScheduleRemoveConfirmView,
  buildScheduleRemoveView,
} from "./schedule-ui";

async function isAllowedCallbackUser(ctx: CallbackQueryContext<Context>): Promise<boolean> {
  const userId = ctx.from?.id?.toString();
  if (!userId) return false;
  const allowlist = await loadAllowlist();
  return isUserAllowed(userId, allowlist);
}

async function isAdminCallbackUser(ctx: CallbackQueryContext<Context>): Promise<boolean> {
  const userId = ctx.from?.id?.toString();
  if (!userId) return false;
  const allowlist = await loadAllowlist();
  if (!isUserAllowed(userId, allowlist)) return false;
  return isAdminUser(userId, allowlist);
}

function withSystemPrompt(prompt: string): string {
  const config = getConfig();
  if (!config.enableSystemPrompt) return prompt;
  const stats = getAIStats();
  const context: SessionContext = {
    messageCount: stats?.messageCount ?? 0,
    recentFailures: stats?.recentFailures ?? 0,
  };
  const memoryContext = loadMemoryContext();
  const systemPrompt = buildSystemPrompt(context, memoryContext, {
    providerDisplayName: config.providerDisplayName,
  });
  return wrapWithSystemPrompt(systemPrompt, prompt);
}

async function editCallbackMessage(
  ctx: CallbackQueryContext<Context>,
  text: string,
  keyboard: InlineKeyboard
): Promise<void> {
  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("message is not modified")) {
      throw err;
    }
  }
}

const CALLBACK_COMMAND_MAP: Record<string, { command: string; args: string }> = {
  cmd_run_stats: { command: "stats", args: "" },
  cmd_run_uptime: { command: "uptime", args: "" },
  cmd_run_version: { command: "version", args: "" },
  cmd_run_id: { command: "id", args: "" },
  cmd_run_ping: { command: "ping", args: "" },
  cmd_run_model: { command: "model", args: "" },
  cmd_run_tts: { command: "tts", args: "" },
  cmd_run_clear: { command: "clear", args: "" },
  cmd_run_session: { command: "session", args: "" },
  cmd_run_todo: { command: "todo", args: "" },
  cmd_run_remind: { command: "remind", args: "" },
  cmd_run_schedule: { command: "schedule", args: "" },
  cmd_run_schedule_checkins: { command: "schedule", args: "checkins status" },
  cmd_run_translate: { command: "translate", args: "" },
  cmd_run_define: { command: "define", args: "" },
  cmd_run_health: { command: "health", args: "" },
  cmd_run_errors: { command: "errors", args: "" },
  cmd_run_errors_patterns: { command: "errors", args: "patterns" },
  cmd_run_analytics_today: { command: "analytics", args: "today" },
  cmd_run_analytics_week: { command: "analytics", args: "week" },
  cmd_run_analytics_month: { command: "analytics", args: "month" },
  cmd_run_disk: { command: "disk", args: "" },
  cmd_run_memory: { command: "memory", args: "" },
  cmd_run_cpu: { command: "cpu", args: "" },
  cmd_run_battery: { command: "battery", args: "" },
  cmd_run_temp: { command: "temp", args: "" },
  cmd_run_top: { command: "top", args: "" },
  cmd_run_ls: { command: "ls", args: "" },
  cmd_run_pwd: { command: "pwd", args: "" },
  cmd_run_cd_home: { command: "cd", args: "~" },
  cmd_run_cat: { command: "cat", args: "" },
  cmd_run_find: { command: "find", args: "" },
  cmd_run_size: { command: "size", args: "" },
  cmd_run_curl: { command: "curl", args: "" },
  cmd_run_net_ip: { command: "net", args: "ip" },
  cmd_run_net_connections: { command: "net", args: "connections" },
  cmd_run_net_speed: { command: "net", args: "speed" },
  cmd_run_ps: { command: "ps", args: "" },
  cmd_run_kill: { command: "kill", args: "" },
  cmd_run_pm2_ls: { command: "pm2", args: "ls" },
  cmd_run_pm2_flush: { command: "pm2", args: "flush" },
  cmd_run_git_status: { command: "git", args: "status" },
  cmd_run_git_log: { command: "git", args: "log" },
  cmd_run_git_pull: { command: "git", args: "pull" },
  cmd_run_sh: { command: "sh", args: "" },
  cmd_run_reboot: { command: "reboot", args: "" },
  cmd_run_sentinel: { command: "sentinel", args: "status" },
  cmd_run_sentinel_on: { command: "sentinel", args: "on" },
  cmd_run_sentinel_off: { command: "sentinel", args: "off" },
  cmd_run_sentinel_run: { command: "sentinel", args: "run" },
  cmd_run_sentinel_create: { command: "sentinel", args: "create" },
  cmd_run_sentinel_edit: { command: "sentinel", args: "edit" },
};

export async function handleCommandCenterCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    if (!(await isAllowedCallbackUser(ctx))) {
      await ctx.answerCallbackQuery("Not authorized");
      return;
    }

    const data = ctx.callbackQuery.data;
    const section = getCommandCenterSection(data);
    if (section) {
      const isAdmin = await isAdminCallbackUser(ctx);
      const view = buildCommandCenterView(isAdmin, section);
      await editCallbackMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery("Updated");
      return;
    }

    const command = CALLBACK_COMMAND_MAP[data];
    if (!command) {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery("Running...");
    await handleCommand(ctx, command.command, command.args);
  } catch (err) {
    error("callbacks", "command_center_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.answerCallbackQuery("Action failed");
  }
}

export async function handleTimerCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    if (!(await isAllowedCallbackUser(ctx))) {
      await ctx.answerCallbackQuery("Not authorized");
      return;
    }
    const match = ctx.callbackQuery.data.match(/^timer_(\d+)$/);
    if (!match) return;
    const seconds = parseInt(match[1], 10);
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const triggerAt = new Date(Date.now() + seconds * 1000).toISOString();
    const label = `Timer ${formatDuration(seconds)}`;
    const schedule = createSchedule({
      type: "once",
      jobType: "shell",
      task: `echo "${label} done!"`,
      output: "telegram",
      name: label,
      scheduledTime: triggerAt,
      userId,
    });
    reloadSchedules();

    await ctx.editMessageText(`\u23F1\uFE0F Timer: *${formatDuration(seconds)}* (schedule #${schedule.id})`, { parse_mode: "Markdown" });
  } catch (err) {
    error("callbacks", "timer_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleWeatherCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  if (!(await isAllowedCallbackUser(ctx))) {
    await ctx.answerCallbackQuery("Not authorized");
    return;
  }
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
      const systemPrompt = buildSystemPrompt(context, memoryContext, {
        providerDisplayName: config.providerDisplayName,
      });
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
    if (!(await isAllowedCallbackUser(ctx))) {
      await ctx.answerCallbackQuery("Not authorized");
      return;
    }
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
    if (!(await isAllowedCallbackUser(ctx))) {
      await ctx.answerCallbackQuery("Not authorized");
      return;
    }
    const isAdmin = await isAdminCallbackUser(ctx);
    const helpText = buildHelpText({
      providerName: getProviderDisplayName(),
      isAdmin,
      includeDangerousWarning: getConfig().security.commandWarningsEnabled,
    });
    await ctx.editMessageText(helpText, {
      parse_mode: "Markdown",
      reply_markup: buildHelpKeyboard(isAdmin),
    });
  } catch (err) {
    error("callbacks", "help_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleWeatherMenuCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    if (!(await isAllowedCallbackUser(ctx))) {
      await ctx.answerCallbackQuery("Not authorized");
      return;
    }
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
    if (!(await isAllowedCallbackUser(ctx))) {
      await ctx.answerCallbackQuery("Not authorized");
      return;
    }
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

export async function handleScheduleCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  let callbackMessage: string | undefined;
  try {
    if (!(await isAllowedCallbackUser(ctx))) {
      await ctx.answerCallbackQuery("Not authorized");
      return;
    }

    const userId = ctx.from?.id?.toString();
    if (!userId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const data = ctx.callbackQuery.data;

    if (data === "sched_home") {
      const view = buildScheduleHomeView(userId);
      await editCallbackMessage(ctx, view.text, view.keyboard);
      callbackMessage = "Schedule manager updated";
      await ctx.answerCallbackQuery(callbackMessage);
      return;
    }

    const listMatch = data.match(/^sched_view_(active|inactive)_(\d+)$/);
    if (listMatch) {
      const view = buildScheduleListView(
        userId,
        listMatch[1] as "active" | "inactive",
        Number.parseInt(listMatch[2], 10)
      );
      await editCallbackMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery();
      return;
    }

    const removeMatch = data.match(/^sched_remove_(\d+)$/);
    if (removeMatch) {
      const view = buildScheduleRemoveView(
        userId,
        Number.parseInt(removeMatch[1], 10)
      );
      await editCallbackMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery();
      return;
    }

    const removeConfirmMatch = data.match(/^sched_rm_id_(\d+)_(\d+)$/);
    if (removeConfirmMatch) {
      const scheduleId = Number.parseInt(removeConfirmMatch[1], 10);
      const page = Number.parseInt(removeConfirmMatch[2], 10);
      const view = buildScheduleRemoveConfirmView(userId, scheduleId, page);
      await editCallbackMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery();
      return;
    }

    const removeAcceptMatch = data.match(/^sched_rm_ok_(\d+)_(\d+)$/);
    if (removeAcceptMatch) {
      const scheduleId = Number.parseInt(removeAcceptMatch[1], 10);
      const page = Number.parseInt(removeAcceptMatch[2], 10);
      const result = cancelSchedule(scheduleId, userId);
      const notice = result.success ? `✅ ${result.message}` : `⚠️ ${result.message}`;
      const view = buildScheduleRemoveView(userId, page, notice);
      await editCallbackMessage(ctx, view.text, view.keyboard);
      callbackMessage = result.success ? "Schedule removed" : "Could not remove";
      await ctx.answerCallbackQuery(callbackMessage);
      return;
    }

    if (data === "sched_checkin_enable") {
      const result = enableRandomCheckins(userId);
      const generationLine = result.generatedToday > 0
        ? `Generated ${result.generatedToday} check-ins for ${result.dateKey}.`
        : `No check-ins generated for ${result.dateKey}${result.skippedReason ? ` (${result.skippedReason})` : "."}`;
      const view = buildScheduleHomeView(
        userId,
        `✅ Random check-ins enabled. ${generationLine}`
      );
      await editCallbackMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery("Random check-ins enabled");
      return;
    }

    if (data === "sched_checkin_disable") {
      const result = disableRandomCheckins(userId);
      const view = buildScheduleHomeView(
        userId,
        `🛑 Random check-ins disabled. Cancelled ${result.cancelledMessages} queued check-in(s).`
      );
      await editCallbackMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery("Random check-ins disabled");
      return;
    }

    if (data === "sched_checkin_regen") {
      const result = regenerateRandomCheckinsForToday(userId);
      const notice = result.generated > 0
        ? `🎲 Regenerated ${result.generated} check-ins for ${result.dateKey}.`
        : `No check-ins generated for ${result.dateKey}${result.skippedReason ? ` (${result.skippedReason})` : "."}`;
      const view = buildScheduleHomeView(userId, notice);
      await editCallbackMessage(ctx, view.text, view.keyboard);
      await ctx.answerCallbackQuery("Random check-ins regenerated");
      return;
    }
  } catch (err) {
    error("callbacks", "schedule_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    callbackMessage = "Schedule action failed";
  }

  await ctx.answerCallbackQuery(callbackMessage);
}

export async function handleModelCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  if (!(await isAllowedCallbackUser(ctx))) {
    await ctx.answerCallbackQuery("Not authorized");
    return;
  }
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
    const isAdmin = await isAdminCallbackUser(ctx);
    if (!isAdmin) {
      await ctx.answerCallbackQuery("Admin-only action");
      return;
    }

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

        const sessionKeyboard = new InlineKeyboard()
          .text("\uD83D\uDD04 Refresh", "session_status")
          .text("\u{1F504} New", "session_new")
          .row()
          .text("\u{1F480} Kill", "session_kill");
        await ctx.editMessageText(status, {
          parse_mode: "Markdown",
          reply_markup: sessionKeyboard,
        });
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
    const isAdmin = await isAdminCallbackUser(ctx);
    if (!isAdmin) {
      await ctx.answerCallbackQuery("Admin-only action");
      return;
    }
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
    const isAdmin = await isAdminCallbackUser(ctx);
    if (!isAdmin) {
      await ctx.answerCallbackQuery("Admin-only action");
      return;
    }
    await ctx.editMessageText("\u{274C} Reboot cancelled.");
  } catch (err) {
    error("callbacks", "reboot_cancel_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await ctx.answerCallbackQuery();
}

export async function handleAIActionCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  let streamHandler: StreamingResponseHandler | null = null;
  try {
    if (!(await isAllowedCallbackUser(ctx))) {
      await ctx.answerCallbackQuery("Not authorized");
      return;
    }

    const match = ctx.callbackQuery.data.match(/^ai_(regen|short|deep)_([a-z0-9]+)$/);
    if (!match) {
      await ctx.answerCallbackQuery();
      return;
    }

    const action = match[1] as "regen" | "short" | "deep";
    const token = match[2];
    const userId = ctx.from?.id?.toString();
    if (!userId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const actionContext = getActionContext(token);
    if (!actionContext) {
      await ctx.answerCallbackQuery("This action expired. Send a new message.");
      return;
    }
    if (actionContext.userId !== userId) {
      await ctx.answerCallbackQuery("This action belongs to another user.");
      return;
    }

    await ctx.answerCallbackQuery("Working...");

    const prompt = buildActionPrompt(action, actionContext.prompt);
    const finalPrompt = withSystemPrompt(prompt);
    streamHandler = new StreamingResponseHandler(ctx);
    const activeStreamHandler = streamHandler;
    activeStreamHandler.startTypingIndicator();
    const onChunk = async (chunk: string): Promise<void> => {
      await activeStreamHandler.handleChunk(chunk);
    };

    const result = await runAI(finalPrompt, onChunk);
    incrementMessages();

    if (!result.success) {
      activeStreamHandler.cleanup();
      recordFailure("unknown");
      await sendErrorResponse(ctx, result.error || "Couldn't generate a response.", userId);
      return;
    }

    recordSuccess();
    await activeStreamHandler.finalize();
    const messageId = activeStreamHandler.getCurrentMessageId();
    if (messageId && ctx.chat) {
      const nextToken = createActionContext(
        userId,
        actionContext.prompt,
        buildResponseContextLabel()
      );
      await ctx.api.editMessageReplyMarkup(ctx.chat.id, messageId, {
        reply_markup: buildActionKeyboard(nextToken, { includePromptActions: true }),
      });
    }
  } catch (err) {
    streamHandler?.cleanup();
    incrementErrors();
    error("callbacks", "ai_action_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.answerCallbackQuery("Something went wrong");
  } finally {
    streamHandler?.cleanup();
  }
}

export async function handleAIContextCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
  try {
    if (!(await isAllowedCallbackUser(ctx))) {
      await ctx.answerCallbackQuery("Not authorized");
      return;
    }

    const match = ctx.callbackQuery.data.match(/^ai_ctx_([a-z0-9]+)$/);
    if (!match) {
      await ctx.answerCallbackQuery();
      return;
    }

    const token = match[1];
    const userId = ctx.from?.id?.toString();
    if (!userId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const actionContext = getActionContext(token);
    if (!actionContext) {
      await ctx.answerCallbackQuery("This context expired. Send a new message.");
      return;
    }
    if (actionContext.userId !== userId) {
      await ctx.answerCallbackQuery("This context belongs to another user.");
      return;
    }

    const contextLabel = actionContext.responseContext ?? "unavailable";
    await ctx.answerCallbackQuery({
      text: `Context: ${contextLabel}`,
      show_alert: false,
    });
  } catch (err) {
    error("callbacks", "ai_context_callback_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.answerCallbackQuery("Something went wrong");
  }
}
