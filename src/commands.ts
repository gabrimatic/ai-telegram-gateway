/**
 * Command handler for the Telegram Gateway bot
 */

import { Context, InlineKeyboard } from "grammy";
import { readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { restartSession, stopSession, getCurrentModel, getStats as getAIStats, getSessionId, isSessionAlive, getCircuitBreakerState, getAIProviderName, switchModel, getAvailableModels, getProviderForModel, isValidModel } from "./ai";
import { getConfig, ModelName, updateConfigOnDisk } from "./config";
import { formatStats, getStartTime, getStats as getHealthStats } from "./health";
import { ICONS, BOT_VERSION } from "./constants";
import { getConfiguredProviderName, getProviderDisplayName, getProviderProcessConfig } from "./provider";
import {
  loadAllowlist,
  isUserAllowed,
  isAdminUser,
} from "./storage";
import {
  parseTimeString,
  formatUptime,
  safeExec,
  escapeMarkdown,
  validateShellArg,
} from "./utils";
import { forwardToClaude } from "./claude-helpers";
import { error as logError } from "./logger";
import {
  listProcesses,
  processDetails,
  killProcess,
  pm2List,
  pm2Restart,
  pm2Stop,
  pm2Start,
  pm2Logs,
  pm2Flush,
  gitStatus,
  gitLog,
  gitPull,
  activeConnections,
  speedTest,
  externalIP,
  temperatures,
} from "./system";
import {
  enableTTSOutput,
  disableTTSOutput,
  getTTSOutputStatus,
} from "./tts";
import {
  cancelSchedule,
  disableRandomCheckins,
  getSchedules,
  getRandomCheckinStatus,
  getScheduleById,
  enableRandomCheckins,
  formatHistory,
  createSchedule,
  regenerateRandomCheckinsForToday,
  reloadSchedules,
} from "./task-scheduler";
import { getTodayStats, getWeekStats, getMonthStats, formatAnalytics, getErrorRate } from "./analytics";
import { checkResources, formatBytes } from "./resource-monitor";
import { getMetrics } from "./metrics";
import { formatRecoveryLog, formatErrorPatterns, getRecentErrorPatterns } from "./self-heal";
import { isWatchdogRunning } from "./watchdog";
import {
  isHeartbeatRunning,
  startHeartbeat,
  stopHeartbeat,
  triggerBeat,
  getHeartbeatStatus,
  getHeartbeatMdPath,
  getHeartbeatMdContent,
  writeHeartbeatMd,
  createDefaultHeartbeatMd,
} from "./heartbeat";
import { env } from "./env";
import { buildScheduleHomeView } from "./schedule-ui";

const DANGEROUS_COMMANDS = new Set(["sh", "reboot"]);
const ADMIN_ONLY_COMMANDS = new Set([
  "analytics",
  "battery",
  "cat",
  "cd",
  "cpu",
  "disk",
  "errors",
  "find",
  "git",
  "health",
  "heartbeat",
  "kill",
  "ls",
  "memory",
  "net",
  "pm2",
  "ps",
  "reboot",
  "session",
  "sh",
  "size",
  "temp",
  "top",
]);

function dangerousCommandDisabledMessage(): string {
  return `${ICONS.warning} This command is disabled by configuration (TG_ENABLE_DANGEROUS_COMMANDS=false).`;
}

function sanitizeCodeBlock(text: string): string {
  return text.replace(/```/g, "\\`\\`\\`");
}

function buildPrivateQuickReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "/help" }, { text: "/model" }],
      [{ text: "/schedule" }, { text: "/session" }],
      [{ text: "/clear" }, { text: "/timer" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Ask me anything or tap a shortcut",
  };
}

export function buildHelpKeyboard(isAdmin: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("\u23F1\uFE0F Timer", "timer_menu")
    .text("\uD83C\uDF24\uFE0F Weather", "weather_menu");

  if (isAdmin) {
    keyboard
      .row()
      .text("\u{1F5A5}\uFE0F Session", "session_status");
  }

  return keyboard;
}

export function buildHelpText(options: {
  providerName: string;
  isAdmin: boolean;
  includeDangerousWarning: boolean;
}): string {
  const safeProvider = escapeMarkdown(options.providerName);
  const lines: string[] = [];

  lines.push("\uD83E\uDD16 *Here's what I can do!*");
  lines.push("");

  if (options.includeDangerousWarning) {
    lines.push(
      `\u26A0\uFE0F Dangerous commands are ${env.TG_ENABLE_DANGEROUS_COMMANDS ? "enabled" : "currently disabled by TG_ENABLE_DANGEROUS_COMMANDS=false"}.`
    );
    lines.push("");
  }

  lines.push("\uD83D\uDCCB *PRODUCTIVITY*");
  lines.push("/schedule /schedules - Manage schedules in chat (list/remove)");
  lines.push("/timer - Quick countdown timer");
  lines.push("/schedule checkins - Random daily check-ins preset");
  lines.push("/todo /remind - Scheduler-backed productivity helpers");
  lines.push("");
  lines.push(`\uD83C\uDF10 *INFO* _(${safeProvider}-powered)_`);
  lines.push("/weather /define /translate");
  lines.push("");
  lines.push("\uD83D\uDCAC *CHAT & SESSION*");
  lines.push("/start /help /stats /id /version /uptime /ping");
  lines.push("/model /tts /clear");
  lines.push("Interaction cues: `again`, `shorter`, `deeper`");

  if (options.isAdmin) {
    lines.push("/session /heartbeat");
    lines.push("");
    lines.push("\uD83D\uDDA5 *SERVER (ADMIN)*");
    lines.push("/pm2 /git /net /sh /ps /kill /top /reboot");
    lines.push("");
    lines.push("\uD83D\uDCC1 *FILES (ADMIN)*");
    lines.push("/cd /ls /pwd /cat /find /size /curl");
    lines.push("");
    lines.push("\uD83D\uDCC8 *MONITORING (ADMIN)*");
    lines.push("/disk /memory /cpu /battery /temp");
    lines.push("/health /analytics /errors");
  } else {
    lines.push("");
    lines.push("\u{1F512} Admin-only system commands are hidden in this view.");
  }

  return lines.join("\n");
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
      const startAction = args.trim().toLowerCase();
      const deepLinkRoute: Record<string, string> = {
        help: "help",
        model: "model",
        session: "session",
        timer: "timer",
        weather: "weather",
        clear: "clear",
      };
      if (startAction && deepLinkRoute[startAction]) {
        return await handleCommand(ctx, deepLinkRoute[startAction], "");
      }

      const safeProviderName = escapeMarkdown(providerName);
      const keyboard = buildHelpKeyboard(isAdmin)
        .row()
        .text("\u2753 Help", "help_show");

      await ctx.reply(
        `*Hey there! \u{1F44B}\u{2728}*\n\nI'm ${safeProviderName}, running via the AI Telegram Gateway! Here's what I can do:\n\n\u{1F4AC} Chat naturally with me\n\u{1F4CE} Send files (photos, docs, audio)\n\u{1F3A4} Send voice messages (transcribed locally)\n\u{1F501} Follow up with: \`again\`, \`shorter\`, \`deeper\`\n\u{2753} Use /help for all the cool commands\n\nQuick actions:`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      if (ctx.chat?.type === "private") {
        await ctx.reply("Quick keyboard enabled for this chat.", {
          reply_markup: buildPrivateQuickReplyKeyboard(),
        });
      }
      return true;
    }

    case "help": {
      const helpText = buildHelpText({
        providerName,
        isAdmin,
        includeDangerousWarning: getConfig().security.commandWarningsEnabled,
      });
      await ctx.reply(helpText, {
        parse_mode: "Markdown",
        reply_markup: buildHelpKeyboard(isAdmin),
      });
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
      await ctx.reply("Fresh start! \u{1F31F} Previous conversation is gone, but your schedules are still safe \u{1F4BE}");
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
      const rawPing = safeExec(`ping -c 3 "${host}" 2>&1`);
      const pingLines = rawPing.split("\n");
      const statsLines = pingLines.filter(l => l.includes("packet loss") || l.includes("min/avg/max") || l.includes("round-trip"));
      const output = statsLines.length > 0 ? statsLines.join("\n") : rawPing;
      await ctx.reply(`\uD83C\uDF10 Ping ${host}:\n\`\`\`\n${sanitizeCodeBlock(output)}\`\`\``, { parse_mode: "Markdown" });
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
      const schedules = getSchedules(userId!);
      const activeCount = schedules.filter((s) => s.status === "active").length;
      await ctx.reply(
        `\u{1F4DD} Todos are now managed through the scheduling system!\n\n` +
        `Just tell me what you need to do in natural language and I'll track it for you.\n` +
        `Use \`/schedule\` to see your ${activeCount} active item(s).`,
        { parse_mode: "Markdown" }
      );
      return true;
    }

    case "remind": {
      const schedules = getSchedules(userId!);
      const activeCount = schedules.filter((s) => s.status === "active").length;
      await ctx.reply(
        `\u{23F0} Reminders now use the scheduling system!\n\n` +
        `Just tell me in natural language what to remind you about, and I'll set it up.\n` +
        `Or use \`/schedule\` to see your ${activeCount} active schedule(s).`,
        { parse_mode: "Markdown" }
      );
      return true;
    }

    case "timer": {
      if (!args.trim()) {
        await ctx.reply(
          `\u{23F1}\u{FE0F} Timers now use the scheduling system!\n\n` +
          `Just tell me what you need timed, e.g. "remind me in 5 minutes to check the oven"\n` +
          `Or use \`/schedule\` to see active schedules.`
        );
        return true;
      }
      const timerParts = args.trim().split(/\s+/);
      const timeStr = timerParts[0];
      const label = timerParts.slice(1).join(" ") || "Timer";
      const parsedMs = parseTimeString(timeStr);
      if (!parsedMs) {
        await ctx.reply(`${ICONS.error} Can't parse that time. Use: 30s, 5m, 1h`);
        return true;
      }
      const triggerAt = new Date(Date.now() + parsedMs).toISOString();
      const schedule = createSchedule({
        type: "once",
        jobType: "shell",
        task: `echo "Timer done"`,
        output: "telegram",
        name: label,
        scheduledTime: triggerAt,
        userId: userId!,
      });
      reloadSchedules();
      await ctx.reply(`\u{23F1}\u{FE0F} Timer set: *${label}* in ${timeStr} (schedule #${schedule.id})`, { parse_mode: "Markdown" });
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
      await ctx.reply(`\uD83D\uDCBE *Disk Usage:*\n\`\`\`\n${sanitizeCodeBlock(output)}\`\`\``, { parse_mode: "Markdown" });
      return true;
    }

    case "memory": {
      await ctx.replyWithChatAction("typing");
      const vmStat = safeExec("vm_stat");
      const totalMemBytes = parseInt(safeExec("sysctl -n hw.memsize").trim(), 10);
      const totalMemGB = (totalMemBytes / (1024 * 1024 * 1024)).toFixed(1);
      const pageSize = 16384; // macOS ARM page size
      const lines = vmStat.split("\n");
      let freePages = 0;
      let activePages = 0;
      let inactivePages = 0;
      let wiredPages = 0;
      let compressedPages = 0;

      for (const line of lines) {
        const val = parseInt(line.match(/(\d+)/)?.[1] || "0", 10);
        if (line.includes("Pages free:")) freePages = val;
        else if (line.includes("Pages active:")) activePages = val;
        else if (line.includes("Pages inactive:")) inactivePages = val;
        else if (line.includes("Pages wired down:")) wiredPages = val;
        else if (line.includes("Pages occupied by compressor:")) compressedPages = val;
      }

      const toGB = (pages: number) => ((pages * pageSize) / (1024 * 1024 * 1024)).toFixed(2);
      const usedPages = activePages + wiredPages + compressedPages;
      const usedGB = (usedPages * pageSize) / (1024 * 1024 * 1024);
      const usedPct = ((usedGB / parseFloat(totalMemGB)) * 100).toFixed(0);

      const memInfo = `\uD83E\uDDE0 *Memory* (${totalMemGB} GB total, ${usedPct}% used)
Active: ${toGB(activePages)} GB
Wired: ${toGB(wiredPages)} GB
Compressed: ${toGB(compressedPages)} GB
Free: ${toGB(freePages)} GB
Inactive: ${toGB(inactivePages)} GB`;
      await ctx.reply(memInfo, { parse_mode: "Markdown" });
      return true;
    }

    case "cpu": {
      await ctx.replyWithChatAction("typing");
      const cpuInfo = safeExec("sysctl -n machdep.cpu.brand_string").trim();
      const coreCount = safeExec("sysctl -n hw.ncpu").trim();
      const perfCores = safeExec("sysctl -n hw.perflevel0.logicalcpu 2>/dev/null").trim();
      const effCores = safeExec("sysctl -n hw.perflevel1.logicalcpu 2>/dev/null").trim();
      const loadRaw = safeExec("sysctl -n vm.loadavg").trim();
      const loadClean = loadRaw.replace(/[{}]/g, "").trim();
      let coreDetail = `Cores: ${coreCount}`;
      if (perfCores && effCores) {
        coreDetail = `Cores: ${coreCount} (${perfCores}P + ${effCores}E)`;
      }
      await ctx.reply(`\u26A1 *CPU*
${cpuInfo}
${coreDetail}
Load: ${loadClean}`, { parse_mode: "Markdown" });
      return true;
    }

    case "battery": {
      await ctx.replyWithChatAction("typing");
      const battery = safeExec("pmset -g batt");
      await ctx.reply(`\uD83D\uDD0B *Battery Status:*\n${battery.trim()}`, { parse_mode: "Markdown" });
      return true;
    }

    // ============ FILE MANAGEMENT COMMANDS ============

    case "cd": {
      const targetDir = args.trim() || homedir();
      const resolvedDir = targetDir.startsWith("~")
        ? targetDir.replace("~", homedir())
        : targetDir;
      try {
        process.chdir(resolvedDir);
        await ctx.reply(`\u{1F4C1} Changed to: \`${process.cwd()}\``, { parse_mode: "Markdown" });
      } catch (err) {
        await ctx.reply(`${ICONS.error} ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }

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
        await ctx.reply(`\uD83D\uDCC1 Files in ${resolvedPath}:\n\`\`\`\n${sanitizeCodeBlock(fileList + truncated)}\`\`\``, { parse_mode: "Markdown" });
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
        truncated = sanitizeCodeBlock(truncated);
        await ctx.reply(`\uD83D\uDCC4 \`${targetPath}\`\n\`\`\`\n${truncated}\`\`\``, { parse_mode: "Markdown" });
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
      const searchDir = process.cwd();
      const output = safeExec(`find "${searchDir}" -name "*${searchName}*" -maxdepth 5 2>/dev/null | head -20`);
      if (!output.trim()) {
        await ctx.reply(`${ICONS.warning} No files found matching "${searchName}"`);
      } else {
        await ctx.reply(`\uD83D\uDD0D Files matching "${searchName}":\n\`\`\`\n${sanitizeCodeBlock(output)}\`\`\``, { parse_mode: "Markdown" });
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
      await ctx.reply(`\uD83C\uDF10 Headers for ${url}:\n\`\`\`\n${sanitizeCodeBlock(output)}\`\`\``, { parse_mode: "Markdown" });
      return true;
    }

    // ============ TASK SCHEDULER COMMANDS ============

    case "schedule": {
      const parts = args.trim() ? args.trim().split(/\s+/) : [];
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
            return `#${s.id} - ${s.history.length} runs, last: ${icon} ${new Date(last.timestamp).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}`;
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

      // /schedule checkins [status|on|off|regen]
      if (subcommand === "checkins" || subcommand === "checkin") {
        const action = parts[1]?.toLowerCase() || "status";
        const status = getRandomCheckinStatus(userId!);

        if (action === "status") {
          const statusText = status.enabled
            ? `ON (planner #${status.masterId}, ${status.activeMessageCount} queued today)`
            : "OFF";
          await ctx.reply(
            `🎲 Random check-ins: ${statusText}\n\n` +
            `Use \`/schedule checkins on\`, \`/schedule checkins off\`, or \`/schedule checkins regen\`.`,
            { parse_mode: "Markdown" }
          );
          return true;
        }

        if (action === "on" || action === "enable") {
          const result = enableRandomCheckins(userId!);
          const generationLine = result.generatedToday > 0
            ? `Generated ${result.generatedToday} check-ins for ${result.dateKey}.`
            : `No check-ins generated for ${result.dateKey}${result.skippedReason ? ` (${result.skippedReason})` : "."}`;
          await ctx.reply(
            `✅ Random check-ins enabled (planner #${result.masterId}).\n${generationLine}`
          );
          return true;
        }

        if (action === "off" || action === "disable") {
          const result = disableRandomCheckins(userId!);
          await ctx.reply(
            `🛑 Random check-ins disabled. Cancelled ${result.cancelledMessages} queued check-in(s).`
          );
          return true;
        }

        if (action === "regen" || action === "regenerate" || action === "refresh") {
          const result = regenerateRandomCheckinsForToday(userId!);
          const summary = result.generated > 0
            ? `🎲 Regenerated ${result.generated} check-ins for ${result.dateKey}.`
            : `No check-ins generated for ${result.dateKey}${result.skippedReason ? ` (${result.skippedReason})` : "."}`;
          await ctx.reply(summary);
          return true;
        }

        await ctx.reply(
          `${ICONS.error} Usage: \`/schedule checkins [status|on|off|regen]\``,
          { parse_mode: "Markdown" }
        );
        return true;
      }

      const view = buildScheduleHomeView(userId!);
      await ctx.reply(view.text, { reply_markup: view.keyboard });
      return true;
    }

    case "schedules": {
      const view = buildScheduleHomeView(userId!);
      await ctx.reply(view.text, { reply_markup: view.keyboard });
      return true;
    }

    // ============ HEARTBEAT (PROACTIVE TURN) ============

    case "heartbeat": {
      const hbArgs = args.trim().toLowerCase();
      const hbStatus = getHeartbeatStatus();
      const config = getConfig();

      if (!hbArgs || hbArgs === "status") {
        const statusIcon = hbStatus.running ? "\u{1F49A}" : "\u{1F6D1}";
        const lines: string[] = [];
        lines.push(`${statusIcon} *Heartbeat ${hbStatus.running ? "Active" : "Stopped"}*`);
        lines.push("");
        lines.push(`Interval: ${config.heartbeat.intervalMinutes}m`);
        lines.push(`Active hours: ${config.heartbeat.activeHoursStart}:00-${config.heartbeat.activeHoursEnd}:00 (${config.heartbeat.timezone})`);
        lines.push(`Checklist: ${hbStatus.checklistExists ? "found" : "not found"}`);
        if (hbStatus.lastBeatTime) {
          lines.push(`Last beat: ${hbStatus.lastBeatTime.toLocaleString("en-GB", { timeZone: config.heartbeat.timezone, dateStyle: "short", timeStyle: "short" })}`);
        }
        lines.push("");

        if (hbStatus.history.length > 0) {
          lines.push("*Recent beats:*");
          const recent = hbStatus.history.slice(-5).reverse();
          for (const entry of recent) {
            const icon = entry.result === "ack" ? "\u{2705}" : entry.result === "alert" ? "\u{1F6A8}" : entry.result === "skipped" ? "\u{23ED}" : "\u{274C}";
            const time = new Date(entry.timestamp).toLocaleString("en-GB", { timeZone: config.heartbeat.timezone, timeStyle: "short" });
            const dur = entry.durationMs ? ` (${(entry.durationMs / 1000).toFixed(1)}s)` : "";
            const msg = entry.message ? ` - ${entry.message.substring(0, 60)}` : "";
            lines.push(`${icon} ${time}${dur}${msg}`);
          }
        } else {
          lines.push("No beat history yet.");
        }

        await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
        return true;
      }

      if (hbArgs === "on") {
        if (hbStatus.running) {
          await ctx.reply("\u{1F49A} Heartbeat is already running!");
          return true;
        }
        startHeartbeat();
        await ctx.reply("\u{1F49A} Heartbeat started! I'll check HEARTBEAT.md every " + config.heartbeat.intervalMinutes + " minutes.");
        return true;
      }

      if (hbArgs === "off") {
        if (!hbStatus.running) {
          await ctx.reply("\u{1F6D1} Heartbeat is already stopped.");
          return true;
        }
        stopHeartbeat();
        await ctx.reply("\u{1F6D1} Heartbeat stopped.");
        return true;
      }

      if (hbArgs === "run") {
        if (!hbStatus.checklistExists) {
          await ctx.reply(`${ICONS.warning} No HEARTBEAT.md found at \`${getHeartbeatMdPath()}\`. Create one first!`, { parse_mode: "Markdown" });
          return true;
        }
        await ctx.reply("\u{1F493} Running heartbeat now...");
        triggerBeat().catch((err) => {
          logError("commands", "heartbeat_trigger_error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return true;
      }

      if (hbArgs === "edit" || hbArgs.startsWith("edit ")) {
        const editText = args.trim().substring(4).trim(); // strip "edit" prefix
        if (editText) {
          // Write new content to HEARTBEAT.md
          writeHeartbeatMd(editText);
          await ctx.reply(`${ICONS.success} HEARTBEAT.md updated!`);
          return true;
        }
        // No text provided - show current content
        const content = getHeartbeatMdContent();
        if (!content) {
          await ctx.reply(`No HEARTBEAT.md found.\n\nUse \`/heartbeat create\` to bootstrap one, or \`/heartbeat edit <content>\` to write one.`, { parse_mode: "Markdown" });
        } else {
          const truncated = content.length > 2000 ? content.substring(0, 2000) + "\n...(truncated)" : content;
          await ctx.reply(`*HEARTBEAT.md*\n\n\`\`\`\n${sanitizeCodeBlock(truncated)}\n\`\`\`\n\nUpdate with: \`/heartbeat edit <new content>\``, { parse_mode: "Markdown" });
        }
        return true;
      }

      if (hbArgs === "create") {
        const created = createDefaultHeartbeatMd();
        if (created) {
          await ctx.reply(`${ICONS.success} Created default HEARTBEAT.md at \`${getHeartbeatMdPath()}\`\n\nUse \`/heartbeat edit\` to view or modify it.`, { parse_mode: "Markdown" });
        } else {
          await ctx.reply(`HEARTBEAT.md already exists. Use \`/heartbeat edit\` to view or update it.`, { parse_mode: "Markdown" });
        }
        return true;
      }

      if (hbArgs.startsWith("interval")) {
        const parts = hbArgs.split(/\s+/);
        const minutes = parseInt(parts[1], 10);
        if (isNaN(minutes) || minutes < 1 || minutes > 1440) {
          await ctx.reply(`${ICONS.error} Usage: \`/heartbeat interval <1-1440>\``, { parse_mode: "Markdown" });
          return true;
        }
        config.heartbeat.intervalMinutes = minutes;
        updateConfigOnDisk(["heartbeat", "intervalMinutes"], minutes);
        if (hbStatus.running) {
          stopHeartbeat();
          startHeartbeat();
        }
        await ctx.reply(`\u{2705} Heartbeat interval set to ${minutes} minutes.${hbStatus.running ? " Timer restarted." : ""}`);
        return true;
      }

      await ctx.reply(
        `*Heartbeat Commands:*\n\n` +
        `/heartbeat - Show status\n` +
        `/heartbeat on - Start heartbeat\n` +
        `/heartbeat off - Stop heartbeat\n` +
        `/heartbeat run - Trigger immediate beat\n` +
        `/heartbeat edit - Show HEARTBEAT.md\n` +
        `/heartbeat edit <text> - Replace HEARTBEAT.md\n` +
        `/heartbeat create - Bootstrap default checklist\n` +
        `/heartbeat interval <min> - Change interval`,
        { parse_mode: "Markdown" }
      );
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
        await ctx.reply(`\u{1F50D} *Error Analysis*\n\n\`\`\`\n${sanitizeCodeBlock(`${patternsText}\n\n${recoveryText}`)}\`\`\``, { parse_mode: "Markdown" });
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

    case "ps": {
      await ctx.replyWithChatAction("typing");
      const psFilter = args.trim() || undefined;
      const psOutput = listProcesses(psFilter);
      const psLabel = psFilter ? `Processes matching "${psFilter}"` : "Top processes";
      await ctx.reply(`\uD83D\uDD0D *${psLabel}*\n\`\`\`\n${sanitizeCodeBlock(psOutput)}\`\`\``, { parse_mode: "Markdown" });
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
      await ctx.reply(`\uD83D\uDC80 *Kill PID ${killPid}*\n\`\`\`\n${sanitizeCodeBlock(`${procInfo}\n${killResult}`)}\`\`\``, { parse_mode: "Markdown" });
      return true;
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
          await ctx.reply(`\u2699\uFE0F *PM2 Processes*\n\`\`\`\n${sanitizeCodeBlock(pmOutput)}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "restart": {
          if (!pmTarget) { await ctx.reply(`\u2139\uFE0F Usage: \`/pm2 restart <name>\``, { parse_mode: "Markdown" }); return true; }
          const pmOutput = pm2Restart(pmTarget);
          await ctx.reply(`\uD83D\uDD04 PM2 restart:\n\`\`\`\n${sanitizeCodeBlock(pmOutput)}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "stop": {
          if (!pmTarget) { await ctx.reply(`\u2139\uFE0F Usage: \`/pm2 stop <name>\``, { parse_mode: "Markdown" }); return true; }
          const pmOutput = pm2Stop(pmTarget);
          await ctx.reply(`\u23F9\uFE0F PM2 stop:\n\`\`\`\n${sanitizeCodeBlock(pmOutput)}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "start": {
          if (!pmTarget) { await ctx.reply(`\u2139\uFE0F Usage: \`/pm2 start <name>\``, { parse_mode: "Markdown" }); return true; }
          const pmOutput = pm2Start(pmTarget);
          await ctx.reply(`\u25B6\uFE0F PM2 start:\n\`\`\`\n${sanitizeCodeBlock(pmOutput)}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "logs": {
          const pmLogParts = pmTarget.split(/\s+/);
          const pmName = pmLogParts[0];
          const pmLines = parseInt(pmLogParts[1], 10) || 30;
          if (!pmName) { await ctx.reply(`\u2139\uFE0F Usage: \`/pm2 logs <name> [lines]\``, { parse_mode: "Markdown" }); return true; }
          const pmOutput = pm2Logs(pmName, pmLines);
          await ctx.reply(`\uD83D\uDCDC *PM2 logs: ${pmName}*\n\`\`\`\n${sanitizeCodeBlock(pmOutput)}\`\`\``, { parse_mode: "Markdown" });
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

    case "git": {
      const gitParts = args.trim().split(/\s+/);
      const gitSub = gitParts[0]?.toLowerCase() || "status";
      const gitRepo = gitParts[1] || undefined;

      await ctx.replyWithChatAction("typing");

      switch (gitSub) {
        case "status": {
          const gitOutput = gitStatus(gitRepo);
          await ctx.reply(`\uD83D\uDCE6 *Git Status${gitRepo ? `: ${gitRepo}` : ""}*\n\`\`\`\n${sanitizeCodeBlock(gitOutput)}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "log": {
          const gitOutput = gitLog(gitRepo);
          await ctx.reply(`\uD83D\uDCE6 *Git Log${gitRepo ? `: ${gitRepo}` : ""}*\n\`\`\`\n${sanitizeCodeBlock(gitOutput)}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        case "pull": {
          if (!env.TG_ENABLE_DANGEROUS_COMMANDS) {
            await ctx.reply(dangerousCommandDisabledMessage());
            return true;
          }
          const gitOutput = gitPull(gitRepo);
          await ctx.reply(`\uD83D\uDCE6 *Git Pull${gitRepo ? `: ${gitRepo}` : ""}*\n\`\`\`\n${sanitizeCodeBlock(gitOutput)}\`\`\``, { parse_mode: "Markdown" });
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

    case "net": {
      const netSub = args.trim().split(/\s+/)[0]?.toLowerCase() || "help";

      await ctx.replyWithChatAction("typing");

      switch (netSub) {
        case "connections": {
          const netOutput = activeConnections();
          await ctx.reply(`\uD83C\uDF10 *Active Connections*\n\`\`\`\n${sanitizeCodeBlock(netOutput)}\`\`\``, { parse_mode: "Markdown" });
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
          await ctx.reply(`\uD83C\uDF10 *Speed Test*\n\`\`\`\n${sanitizeCodeBlock(netOutput)}\`\`\``, { parse_mode: "Markdown" });
          return true;
        }
        default: {
          await ctx.reply(`\uD83C\uDF10 *Network Commands:*
\`/net connections\` - Active connections
\`/net ip\` - External IP address
\`/net speed\` - Speed test
\`/ping <host>\` - Ping a host`, { parse_mode: "Markdown" });
          return true;
        }
      }
    }

    case "temp": {
      await ctx.replyWithChatAction("typing");
      const tempOutput = temperatures();
      await ctx.reply(`\uD83C\uDF21 *Temperature*\n${tempOutput}`);
      return true;
    }

    case "top": {
      await ctx.replyWithChatAction("typing");
      const topOutput = safeExec("ps aux -r | head -15 | awk '{printf \"%-12s %5s %5s %s\\n\", $1, $3, $4, $11}'");
      await ctx.reply(`\u26A1 *Top Processes*\n\`\`\`\n${sanitizeCodeBlock(topOutput)}\`\`\``, { parse_mode: "Markdown" });
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
        await ctx.reply(`\`\`\`\n${sanitizeCodeBlock(shOutput)}\`\`\``, { parse_mode: "Markdown" });
      }
      return true;
    }

    // ============ SESSION MANAGEMENT COMMANDS ============

    case "session": {
      const sessionSub = args.trim().toLowerCase();
      const sessionKeyboard = new InlineKeyboard()
        .text("\uD83D\uDD04 Refresh", "session_status")
        .text("\u{1F504} New", "session_new")
        .row()
        .text("\u{1F480} Kill", "session_kill");

      if (!sessionSub || sessionSub === "status") {
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

        sessInfo += `\n\nUse \`/session kill\` or \`/session new\``;
        await ctx.reply(sessInfo, { parse_mode: "Markdown", reply_markup: sessionKeyboard });
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

      // Unknown subcommand - show usage
      await ctx.reply(`\u{1F5A5} *Session Commands:*\n\`/session\` - Show status\n\`/session kill\` - Force kill\n\`/session new\` - Fresh session`, { parse_mode: "Markdown" });
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
