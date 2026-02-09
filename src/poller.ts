/**
 * Main poller module for the Telegram Gateway bot
 * Handles message processing and bot lifecycle
 */

import * as fs from "fs";
import { Bot, Context } from "grammy";
import { runAI, getStats, isSessionStuck, isSessionRestarting, restartSession, getSessionId } from "./ai";
import { getConfig } from "./config";
import { info, warn, error, debug } from "./logger";
import { incrementMessages, incrementErrors } from "./health";
import { recordSuccess, recordFailure } from "./metrics";
import { buildSystemPrompt, wrapWithSystemPrompt, SessionContext } from "./system-prompt";
import { loadMemoryContext } from "./memory";
import { getProviderDisplayName } from "./provider";
import { transcribeVoiceMessage, isVoiceTranscriptionAvailable } from "./voice";
import { sendResponse, sendErrorResponse, sendTypingIndicator, StreamingResponseHandler } from "./response-handler";
import { isTTSOutputEnabled } from "./tts";
import { isDeployPending } from "./deployer";
import {
  downloadTelegramFile,
  formatFileMetadata,
  FileMetadata,
  FileType,
  MAX_DOWNLOAD_SIZE,
} from "./files";

// Fallback messages when the AI provider is unavailable
function getFallbackRestartingMessage(): string {
  const providerName = getProviderDisplayName();
  return `Hold on! ${providerName} is restarting right now \u{1F504} Give it 5-10 seconds and try again!`;
}

function getFallbackStuckMessage(): string {
  const providerName = getProviderDisplayName();
  return `Oops, ${providerName} got stuck on something \u{1F605} Restarting now! Try again in about 10 seconds \u{1F44D}`;
}

/**
 * Generate a unique request ID for tracing
 * Format: req-{timestamp}-{random4chars}
 */
function generateRequestId(): string {
  const timestamp = Date.now();
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let random = "";
  for (let i = 0; i < 4; i++) {
    random += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `req-${timestamp}-${random}`;
}
import {
  loadAllowlist,
  saveAllowlist,
  isUserAllowed,
  generatePairingCode,
} from "./storage";
import { handleCommand } from "./commands";
import { trackInboundMessage, trackOutboundMessage, trackCommand } from "./analytics";
import { recordError as recordSelfHealError } from "./self-heal";

// In-flight message counter for deploy drain
let inFlightCount = 0;
export function getInFlightCount(): number {
  return inFlightCount;
}

// Track whether the AI backend is actively processing a request.
// When true, new messages should be queued into the backend (which preserves
// context in persistent sessions like Claude CLI) rather than triggering
// stuck-detection or session restarts.
let aiProcessingCount = 0;

import {
  handleTodoCallback,
  handleTimerCallback,
  handleRandomCallback,
  handleTimeCallback,
  handleWeatherCallback,
  handleTranslateCallback,
  handleCalcCallback,
  handleHelpCallback,
  handleWeatherMenuCallback,
  handleTimerMenuCallback,
  handleNotesListCallback,
  handleTodoConfirmClearCallback,
  handleTodoCancelClearCallback,
  handleNotesConfirmClearCallback,
  handleNotesCancelClearCallback,
  handleModelCallback,
  handleSessionCallback,
  handleRebootConfirmCallback,
  handleRebootCancelCallback,
  handleSleepConfirmCallback,
  handleSleepCancelCallback,
} from "./callbacks";

/**
 * Handle file messages (documents, photos, videos, etc.)
 */
async function handleFileMessage(
  ctx: Context,
  fileType: FileType,
  fileInfo: {
    fileId: string;
    fileSize?: number;
    fileName?: string;
    mimeType?: string;
    caption?: string;
  },
  requestId: string
): Promise<void> {
  const userId = ctx.from?.id?.toString();
  if (!userId) return;

  const allowlist = await loadAllowlist();
  const providerName = getProviderDisplayName();

  // Check if user is allowed
  if (!isUserAllowed(userId, allowlist)) {
    if (allowlist.pairingEnabled) {
      await ctx.reply(`Hey there! \u{1F44B} This is a private bot that runs ${providerName}. You'll need a pairing code to use it! If you have one, send: /pair YOUR_CODE`);
    } else {
      await ctx.reply(`Hey! \u{1F44B} This is a private bot running ${providerName}. Not open for public use, sorry!`);
    }
    debug("poller", "rejected_unauthorized_file", { userId, fileType }, requestId);
    return;
  }

  // Check file size
  if (fileInfo.fileSize && fileInfo.fileSize > MAX_DOWNLOAD_SIZE) {
    const maxMB = Math.round(MAX_DOWNLOAD_SIZE / 1024 / 1024);
    const fileMB = (fileInfo.fileSize / 1024 / 1024).toFixed(1);
    await ctx.reply(
      `Whoa, that file is ${fileMB}MB! \u{1F4E6} The limit is ${maxMB}MB (Telegram's rule, not mine!). Try uploading it somewhere and sharing the link instead \u{1F517}`
    );
    return;
  }

  debug("poller", "processing_file_message", {
    userId,
    fileType,
    fileId: fileInfo.fileId,
    fileSize: fileInfo.fileSize,
  }, requestId);

  try {
    await sendTypingIndicator(ctx);

    // Get file from Telegram
    const file = await ctx.api.getFile(fileInfo.fileId);
    if (!file.file_path) {
      await ctx.reply("Hmm, Telegram didn't give me a download link for that file \u{1F914} Maybe it expired or their servers are hiccuping. Try sending it again!");
      return;
    }

    // Get session ID for file storage
    const sessionId = getSessionId();

    // Determine filename
    const filename = fileInfo.fileName || `${fileType}_${fileInfo.fileId}`;

    // Download file
    const localPath = await downloadTelegramFile(
      ctx.api.token,
      file.file_path,
      sessionId,
      filename
    );

    // Get actual file size if not provided
    const fileStat = fs.statSync(localPath);
    const actualFileSize = fileInfo.fileSize || fileStat.size;

    // Build metadata
    const metadata: FileMetadata = {
      type: fileType,
      filename,
      mimeType: fileInfo.mimeType || "application/octet-stream",
      fileSize: actualFileSize,
      localPath,
      caption: fileInfo.caption,
    };

    // Format metadata for Claude
    const metadataBlock = formatFileMetadata(metadata);

    // Build prompt with file context
    const promptText = fileInfo.caption
      ? `${metadataBlock}\n\nUser message: ${fileInfo.caption}`
      : `${metadataBlock}\n\nUser sent a file. Analyze or process it as needed.`;

    // Process with Claude
    await processTextWithClaude(ctx, userId, promptText, { hasFileAttachment: true, requestId });

  } catch (err) {
    incrementErrors();
    const errorMsg = err instanceof Error ? err.message : String(err);
    error("poller", "file_processing_failed", {
      error: errorMsg,
      fileType,
    }, requestId);
    await sendErrorResponse(ctx, `Oops! Couldn't process your ${fileType} \u{1F625} Error: ${errorMsg}. Maybe try a smaller file or different format?`, userId);
  }
}

/**
 * Handle document messages
 */
async function handleDocumentMessage(ctx: Context): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc) return;

  const requestId = generateRequestId();
  await handleFileMessage(ctx, "document", {
    fileId: doc.file_id,
    fileSize: doc.file_size,
    fileName: doc.file_name || "document",
    mimeType: doc.mime_type,
    caption: ctx.message?.caption,
  }, requestId);
}

/**
 * Handle photo messages
 */
async function handlePhotoMessage(ctx: Context): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return;

  // Use the largest photo size (last in array)
  const photo = photos[photos.length - 1];

  const requestId = generateRequestId();
  await handleFileMessage(ctx, "photo", {
    fileId: photo.file_id,
    fileSize: photo.file_size,
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    caption: ctx.message?.caption,
  }, requestId);
}

/**
 * Handle video messages
 */
async function handleVideoMessage(ctx: Context): Promise<void> {
  const video = ctx.message?.video;
  if (!video) return;

  const requestId = generateRequestId();
  await handleFileMessage(ctx, "video", {
    fileId: video.file_id,
    fileSize: video.file_size,
    fileName: video.file_name || "video.mp4",
    mimeType: video.mime_type || "video/mp4",
    caption: ctx.message?.caption,
  }, requestId);
}

/**
 * Handle audio messages (NOT voice - that goes through transcription)
 */
async function handleAudioMessage(ctx: Context): Promise<void> {
  const audio = ctx.message?.audio;
  if (!audio) return;

  const requestId = generateRequestId();
  await handleFileMessage(ctx, "audio", {
    fileId: audio.file_id,
    fileSize: audio.file_size,
    fileName: audio.file_name || audio.title || "audio.mp3",
    mimeType: audio.mime_type || "audio/mpeg",
    caption: ctx.message?.caption,
  }, requestId);
}

/**
 * Handle sticker messages
 */
async function handleStickerMessage(ctx: Context): Promise<void> {
  const sticker = ctx.message?.sticker;
  if (!sticker) return;

  // Stickers can be static (webp) or animated (tgs/webm)
  const isAnimated = sticker.is_animated;
  const isVideo = sticker.is_video;
  const mimeType = isVideo ? "video/webm" : isAnimated ? "application/x-tgsticker" : "image/webp";
  const ext = isVideo ? "webm" : isAnimated ? "tgs" : "webp";

  const requestId = generateRequestId();
  await handleFileMessage(ctx, "sticker", {
    fileId: sticker.file_id,
    fileSize: sticker.file_size,
    fileName: `sticker.${ext}`,
    mimeType,
    caption: sticker.emoji ? `Sticker emoji: ${sticker.emoji}` : undefined,
  }, requestId);
}

/**
 * Handle animation (GIF) messages
 */
async function handleAnimationMessage(ctx: Context): Promise<void> {
  const animation = ctx.message?.animation;
  if (!animation) return;

  const requestId = generateRequestId();
  await handleFileMessage(ctx, "animation", {
    fileId: animation.file_id,
    fileSize: animation.file_size,
    fileName: animation.file_name || "animation.mp4",
    mimeType: animation.mime_type || "video/mp4",
    caption: ctx.message?.caption,
  }, requestId);
}

/**
 * Handle video note (round video) messages
 */
async function handleVideoNoteMessage(ctx: Context): Promise<void> {
  const videoNote = ctx.message?.video_note;
  if (!videoNote) return;

  const requestId = generateRequestId();
  await handleFileMessage(ctx, "video_note", {
    fileId: videoNote.file_id,
    fileSize: videoNote.file_size,
    fileName: "video_note.mp4",
    mimeType: "video/mp4",
    caption: undefined,
  }, requestId);
}

async function handleMessage(ctx: Context): Promise<void> {
  const userId = ctx.from?.id?.toString();
  const messageText = ctx.message?.text;

  if (!userId || !messageText) {
    return;
  }

  // Reject new messages during deploy drain
  if (isDeployPending()) {
    await ctx.reply("Restarting with a new version. Back in a few seconds!");
    return;
  }

  const requestId = generateRequestId();
  const allowlist = await loadAllowlist();
  const providerName = getProviderDisplayName();

  // Track inbound message for analytics
  trackInboundMessage();

  // Check for commands
  if (messageText.startsWith("/")) {
    const parts = messageText.slice(1).split(" ");
    const command = parts[0];
    const args = parts.slice(1).join(" ");

    // Track command usage
    trackCommand(command);

    // Handle pairing
    if (command === "pair" && !isUserAllowed(userId, allowlist)) {
      if (!allowlist.pairingEnabled) {
        await ctx.reply("Pairing mode is off right now \u{1F512} The admin needs to enable it first. Ask for access!");
        return;
      }

      const providedCode = args.trim();
      if (providedCode === allowlist.pairingCode) {
        allowlist.allowedUsers.push(userId);
        allowlist.pairingCode = generatePairingCode();
        await saveAllowlist(allowlist);
        info("poller", "user_paired", { userId }, requestId);
        await ctx.reply(
          `Welcome aboard! \u{1F389}\u{2728}\n\nYou're now connected! This bot runs ${providerName}. Chat naturally, send files, or use /help to see all the cool stuff you can do!\n\nHeads up: Each conversation starts fresh - I don't remember previous chats \u{1F4AD}`
        );
      } else {
        warn("poller", "invalid_pairing_code", { userId }, requestId);
        await ctx.reply("Hmm, that code didn't work \u{1F914} Codes are case-sensitive and single-use. Ask the admin for a fresh one!");
      }
      return;
    }

    // Handle other commands
    if (await handleCommand(ctx, command, args)) {
      return;
    }
  }

  // Check if user is allowed
  if (!isUserAllowed(userId, allowlist)) {
    if (allowlist.pairingEnabled) {
      await ctx.reply(
        `Hey there! \u{1F44B} This is a private bot that runs ${providerName}. You'll need a pairing code to use it! If you have one, send: /pair YOUR_CODE`
      );
    } else {
      await ctx.reply(`Hey! \u{1F44B} This is a private bot running ${providerName}. Not open for public use, sorry!`);
    }
    debug("poller", "rejected_unauthorized", { userId }, requestId);
    return;
  }

  // User is allowed, process with AI
  const isQueued = aiProcessingCount > 0;
  debug("poller", "processing_message", {
    userId,
    length: messageText.length,
    preview: messageText.substring(0, 50),
    queued: isQueued,
  }, requestId);

  // Only check session health for the first message.
  // If the AI is already processing, the new message will be queued into the
  // same session (preserving conversation context) rather than triggering a
  // restart that would kill the in-progress response.
  if (!isQueued) {
    // Check if session is currently restarting - respond immediately
    if (isSessionRestarting()) {
      await ctx.reply(getFallbackRestartingMessage());
      return;
    }

    // Check if session is stuck - trigger restart and respond
    if (isSessionStuck()) {
      warn("poller", "session_stuck_detected", { userId }, requestId);
      await ctx.reply(getFallbackStuckMessage());
      // Trigger restart in background
      restartSession().catch((err) => {
        error("poller", "restart_failed", {
          error: err instanceof Error ? err.message : String(err),
        }, requestId);
      });
      return;
    }
  } else {
    debug("poller", "queueing_mid_stream", { userId, activeRequests: aiProcessingCount }, requestId);
  }

  inFlightCount++;
  aiProcessingCount++;
  const streamHandler = new StreamingResponseHandler(ctx);
  streamHandler.startTypingIndicator();

  try {
    const config = getConfig();
    let prompt = messageText;

    // Build system prompt if enabled
    if (config.enableSystemPrompt) {
      const stats = getStats();
      const context: SessionContext = {
        messageCount: stats?.messageCount ?? 0,
        recentFailures: stats?.recentFailures ?? 0,
      };
      const memoryContext = loadMemoryContext();
      const systemPrompt = buildSystemPrompt(context, memoryContext, {
        providerDisplayName: config.providerDisplayName,
      });
      prompt = wrapWithSystemPrompt(systemPrompt, messageText);
    }

    const onChunk = async (chunk: string): Promise<void> => {
      await streamHandler.handleChunk(chunk);
    };

    const aiStartTime = Date.now();
    const result = await runAI(prompt, onChunk);
    const responseTimeMs = Date.now() - aiStartTime;

    incrementMessages();

    if (result.success) {
      recordSuccess();
      trackOutboundMessage(responseTimeMs, result.response.length);
      await streamHandler.finalize();
      debug("poller", "message_processed", {
        userId,
        responseLength: result.response.length,
        responseTimeMs,
      }, requestId);
    } else {
      streamHandler.cleanup();
      recordFailure("unknown");
      const errorType = result.error?.includes("timed out") ? "timeout" : "unknown";
      recordSelfHealError(errorType, result.error || "unknown");
      // Check if this was a timeout - offer restart message
      const isTimeout = errorType === "timeout";
      const partialText = streamHandler.getAccumulatedText().trim();
      const errorMsg = partialText
        ? partialText // Send whatever partial response we got
        : isTimeout
          ? `Whew, that took too long! \u{23F1}\u{FE0F} ${getProviderDisplayName()} got stuck on something complex (over 2 min). The session will auto-restart. Try again, maybe with a simpler request? \u{1F64F}`
          : `Oops, something went wrong \u{1F605} ${result.error || "Unknown error"}. Try rephrasing or send /clear for a fresh start!`;
      await sendErrorResponse(ctx, errorMsg, userId);
      debug("poller", "message_failed", {
        userId,
        error: result.error,
        isTimeout,
      }, requestId);
    }
  } catch (err) {
    streamHandler.cleanup();
    incrementErrors();
    const errorMsg = err instanceof Error ? err.message : String(err);
    recordSelfHealError("exception", errorMsg);
    error("poller", "message_processing_failed", {
      error: errorMsg,
    }, requestId);
    await sendErrorResponse(ctx, `Yikes! Something broke on my end \u{1F62C}: ${errorMsg}. Try again, or send /clear for a fresh start if it keeps happening!`, userId);
  } finally {
    inFlightCount--;
    aiProcessingCount--;
  }
}

/**
 * Process transcribed text through Claude (shared logic with text messages)
 */
async function processTextWithClaude(
  ctx: Context,
  userId: string,
  text: string,
  options?: { isVoiceInput?: boolean; hasFileAttachment?: boolean; requestId?: string }
): Promise<void> {
  const requestId = options?.requestId || generateRequestId();
  const isQueued = aiProcessingCount > 0;

  if (!isQueued) {
    // Check if session is currently restarting
    if (isSessionRestarting()) {
      await sendErrorResponse(ctx, getFallbackRestartingMessage(), userId);
      return;
    }

    if (isDeployPending()) {
      await sendErrorResponse(ctx, "Restarting with a new version. Back in a few seconds!", userId);
      return;
    }

    // Check if session is stuck
    if (isSessionStuck()) {
      warn("poller", "session_stuck_detected", { userId }, requestId);
      await sendErrorResponse(ctx, getFallbackStuckMessage(), userId);
      restartSession().catch((err) => {
        error("poller", "restart_failed", {
          error: err instanceof Error ? err.message : String(err),
        }, requestId);
      });
      return;
    }
  }

  inFlightCount++;
  aiProcessingCount++;
  // For voice input, use accumulate-only mode (sendResponse handles TTS output)
  const streamHandler = new StreamingResponseHandler(ctx, {
    accumulateOnly: options?.isVoiceInput
  });
  streamHandler.startTypingIndicator();

  try {
    const config = getConfig();
    let prompt = text;

    // Build system prompt if enabled
    if (config.enableSystemPrompt) {
      const stats = getStats();
      const context: SessionContext = {
        messageCount: stats?.messageCount ?? 0,
        recentFailures: stats?.recentFailures ?? 0,
        isVoiceInput: options?.isVoiceInput,
        hasFileAttachment: options?.hasFileAttachment,
        isTTSEnabled: isTTSOutputEnabled(),
      };
      const memoryContext = loadMemoryContext();
      const systemPrompt = buildSystemPrompt(context, memoryContext, {
        providerDisplayName: config.providerDisplayName,
      });
      prompt = wrapWithSystemPrompt(systemPrompt, text);
    }

    const onChunk = async (chunk: string): Promise<void> => {
      await streamHandler.handleChunk(chunk);
    };

    const aiStartTime = Date.now();
    const result = await runAI(prompt, onChunk);
    const responseTimeMs = Date.now() - aiStartTime;

    incrementMessages();

    if (result.success) {
      recordSuccess();
      trackOutboundMessage(responseTimeMs, result.response.length);
      // For voice input, use sendResponse with TTS; for text, finalize handles it
      if (options?.isVoiceInput) {
        streamHandler.cleanup();
        const replyText = streamHandler.getAccumulatedText().trim() || result.response.trim();
        if (replyText) {
          await sendResponse(ctx, {
            text: replyText,
            userId,
            includeAudio: true,
          });
        }
      } else {
        await streamHandler.finalize();
      }
      debug("poller", "message_processed", {
        userId,
        responseLength: result.response.length,
        responseTimeMs,
      }, requestId);
    } else {
      streamHandler.cleanup();
      recordFailure("unknown");
      const errorType = result.error?.includes("timed out") ? "timeout" : "unknown";
      recordSelfHealError(errorType, result.error || "unknown");
      const isTimeout = errorType === "timeout";
      const partialText = streamHandler.getAccumulatedText().trim();
      const errorMsg = partialText
        ? partialText
        : isTimeout
          ? `Whew, that took too long! \u{23F1}\u{FE0F} ${getProviderDisplayName()} got stuck on something complex (over 2 min). The session will auto-restart. Try again, maybe with a simpler request? \u{1F64F}`
          : `Oops, something went wrong \u{1F605} ${result.error || "Unknown error"}. Try rephrasing or send /clear for a fresh start!`;
      await sendErrorResponse(ctx, errorMsg, userId);
      debug("poller", "message_failed", {
        userId,
        error: result.error,
        isTimeout,
      }, requestId);
    }
  } catch (err) {
    streamHandler.cleanup();
    incrementErrors();
    const errorMsg = err instanceof Error ? err.message : String(err);
    recordSelfHealError("exception", errorMsg);
    error("poller", "message_processing_failed", {
      error: errorMsg,
    }, requestId);
    await sendErrorResponse(ctx, `Yikes! Something broke on my end \u{1F62C}: ${errorMsg}. Try again, or send /clear for a fresh start if it keeps happening!`, userId);
  } finally {
    inFlightCount--;
    aiProcessingCount--;
  }
}

/**
 * Handle voice messages - transcribe and process as text
 */
async function handleVoiceMessage(ctx: Context): Promise<void> {
  const userId = ctx.from?.id?.toString();
  const voice = ctx.message?.voice;

  if (!userId || !voice) {
    return;
  }

  const requestId = generateRequestId();
  const providerName = getProviderDisplayName();

  // Check if voice transcription is available
  if (!(await isVoiceTranscriptionAvailable())) {
    await ctx.reply("Voice messages need WhisperKit running, but it's offline right now \u{1F3A4}\u{274C} Send a text message instead, or ask the admin to start WhisperKit!");
    return;
  }

  const allowlist = await loadAllowlist();

  // Check if user is allowed
  if (!isUserAllowed(userId, allowlist)) {
    if (allowlist.pairingEnabled) {
      await ctx.reply(`Hey there! \u{1F44B} This is a private bot that runs ${providerName}. You'll need a pairing code to use it! If you have one, send: /pair YOUR_CODE`);
    } else {
      await ctx.reply(`Hey! \u{1F44B} This is a private bot running ${providerName}. Not open for public use, sorry!`);
    }
    debug("poller", "rejected_unauthorized_voice", { userId }, requestId);
    return;
  }

  debug("poller", "processing_voice_message", {
    userId,
    duration: voice.duration,
    fileId: voice.file_id,
  }, requestId);

  try {
    // Show typing indicator while transcribing
    await ctx.replyWithChatAction("typing");

    // Get file URL from Telegram
    const file = await ctx.api.getFile(voice.file_id);
    if (!file.file_path) {
      await ctx.reply("Hmm, Telegram didn't give me a download link for your voice message \u{1F914} That's weird! Try recording and sending it again?");
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;

    // Transcribe the voice message
    const transcription = await transcribeVoiceMessage(fileUrl, voice.file_id);

    if (!transcription.success || !transcription.text) {
      await ctx.reply(`Couldn't quite catch that! \u{1F442} ${transcription.error ? `Error: ${transcription.error}` : "The audio might be too quiet, too noisy, or in a funky format."} Try speaking a bit more clearly or send a text message instead?`);
      incrementErrors();
      return;
    }

    // Show the transcription to the user
    const transcribedText = transcription.text.trim();
    if (!transcribedText) {
      await ctx.reply("Processed your voice message but got nothing \u{1F914} Might be silent or just background noise? Try recording again somewhere quieter!");
      return;
    }

    info("poller", "voice_transcribed", {
      userId,
      duration: voice.duration,
      textLength: transcribedText.length,
      transcriptionMs: transcription.durationMs,
    }, requestId);

    // Process the transcribed text with Claude - identical to text message handling
    // No prefix, no indication it was a voice message
    await processTextWithClaude(ctx, userId, transcribedText, { isVoiceInput: true, requestId });

  } catch (err) {
    incrementErrors();
    const errorMsg = err instanceof Error ? err.message : String(err);
    error("poller", "voice_processing_failed", {
      error: errorMsg,
    }, requestId);
    await ctx.reply(`Oops, couldn't process your voice message \u{1F625}: ${errorMsg}. Might be WhisperKit or the Telegram download acting up. Try sending a text message instead!`);
  }
}

export async function createBot(
  token: string,
  options?: { skipSetMyCommands?: boolean; botInfo?: Record<string, unknown> }
): Promise<Bot> {
  const bot = options?.botInfo ? new Bot(token, { botInfo: options.botInfo as any }) : new Bot(token);
  const skipSetMyCommands = options?.skipSetMyCommands ?? false;

  // Set command menu (shown when users type '/' in Telegram)
  // Grouped logically: session, productivity, utilities, info, system, files, network
  if (!skipSetMyCommands) {
    await bot.api.setMyCommands([
    // Session commands
    { command: "start", description: "Welcome & quick actions" },
    { command: "help", description: "Show all commands" },
    { command: "clear", description: "Clear session and start fresh" },
    { command: "stats", description: "Bot statistics" },
    { command: "model", description: "Switch model (haiku/opus)" },
    { command: "tts", description: "Toggle voice output on/off" },
    // Productivity
    { command: "todo", description: "Manage todo list" },
    { command: "note", description: "Save a quick note" },
    { command: "notes", description: "List saved notes" },
    { command: "remind", description: "Set a reminder" },
    { command: "timer", description: "Set a countdown timer" },
    { command: "schedule", description: "Schedule a task (one-time or cron)" },
    { command: "schedules", description: "List scheduled tasks" },
    // Utilities
    { command: "calc", description: "Calculator" },
    { command: "random", description: "Random number generator" },
    { command: "pick", description: "Pick from comma-separated options" },
    { command: "uuid", description: "Generate UUID" },
    { command: "time", description: "World clock" },
    { command: "date", description: "Current date & week number" },
    // Info (Claude-powered)
    { command: "weather", description: "Weather info for a city" },
    { command: "define", description: "Define a word" },
    { command: "translate", description: "Translate text" },
    // System info
    { command: "disk", description: "Disk usage" },
    { command: "memory", description: "Memory usage" },
    { command: "cpu", description: "CPU info" },
    { command: "battery", description: "Battery status" },
    // Files
    { command: "ls", description: "List directory contents" },
    { command: "pwd", description: "Current working directory" },
    { command: "cat", description: "Read file contents" },
    { command: "find", description: "Find files by name" },
    { command: "size", description: "Get file/folder size" },
    // Network
    { command: "ping", description: "Latency check or ping a host" },
    { command: "dns", description: "DNS lookup" },
    { command: "curl", description: "Fetch URL headers" },
    // Server management
    { command: "sys", description: "Full system dashboard" },
    { command: "docker", description: "Docker container management" },
    { command: "pm2", description: "PM2 process manager" },
    { command: "brew", description: "Homebrew package management" },
    { command: "git", description: "Git repo status/log/pull" },
    { command: "kill", description: "Kill process by PID" },
    { command: "ports", description: "Show listening ports" },
    { command: "net", description: "Network info (ip/speed/connections)" },
    { command: "ps", description: "List/filter processes" },
    { command: "df", description: "Detailed disk usage" },
    { command: "top", description: "Top processes by CPU" },
    { command: "temp", description: "CPU temperature" },
    // Monitoring
    { command: "health", description: "System health dashboard" },
    { command: "analytics", description: "Usage statistics" },
    { command: "errors", description: "Error analysis & patterns" },
    // Snippets
    { command: "snippet", description: "Save/run command snippets" },
    { command: "snippets", description: "List saved snippets" },
    // Shell access
    { command: "sh", description: "Execute shell command" },
    { command: "shlong", description: "Execute long-running command" },
    // File transfer
    { command: "upload", description: "Download file to path (reply to file)" },
    { command: "tree", description: "Directory tree view" },
    // Session management
    { command: "session", description: "Manage Claude sessions" },
    { command: "sessions", description: "Show active sessions" },
    { command: "context", description: "Current session context info" },
    // Notification preferences
    { command: "quiet", description: "Toggle quiet mode" },
    { command: "dnd", description: "Do not disturb mode" },
    // System shortcuts
    { command: "reboot", description: "Reboot host machine" },
    { command: "sleep", description: "Sleep host machine" },
    { command: "screenshot", description: "Take and send a screenshot" },
    { command: "deploy", description: "Deploy code changes safely" },
    // Meta
    { command: "id", description: "Your Telegram user ID" },
    { command: "version", description: "Bot version" },
    { command: "uptime", description: "Bot uptime" },
    ]);
  }

  // Register callback query handlers
  bot.callbackQuery(/^todo_(add|list|clear)$/, handleTodoCallback);
  bot.callbackQuery("todo_confirm_clear", handleTodoConfirmClearCallback);
  bot.callbackQuery("todo_cancel_clear", handleTodoCancelClearCallback);
  bot.callbackQuery(/^timer_\d+$/, handleTimerCallback);
  bot.callbackQuery("timer_menu", handleTimerMenuCallback);
  bot.callbackQuery(/^random_\d+_\d+$/, handleRandomCallback);
  bot.callbackQuery(/^time_.+$/, handleTimeCallback);
  bot.callbackQuery("weather_menu", handleWeatherMenuCallback);
  bot.callbackQuery(/^weather_.+$/, handleWeatherCallback);
  bot.callbackQuery(/^translate_.+$/, handleTranslateCallback);
  bot.callbackQuery("calc_clear", handleCalcCallback);
  bot.callbackQuery("help_show", handleHelpCallback);
  bot.callbackQuery("notes_list", handleNotesListCallback);
  bot.callbackQuery("notes_confirm_clear", handleNotesConfirmClearCallback);
  bot.callbackQuery("notes_cancel_clear", handleNotesCancelClearCallback);
  bot.callbackQuery(/^model_\w+$/, handleModelCallback);
  bot.callbackQuery(/^session_(status|kill|new)$/, handleSessionCallback);
  bot.callbackQuery("reboot_confirm", handleRebootConfirmCallback);
  bot.callbackQuery("reboot_cancel", handleRebootCancelCallback);
  bot.callbackQuery("sleep_confirm", handleSleepConfirmCallback);
  bot.callbackQuery("sleep_cancel", handleSleepCancelCallback);

  // Catch-all handler to prevent loading spinners on unknown callbacks
  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.on("message:text", handleMessage);
  // Voice handler MUST be registered before audio handler
  // Voice messages have transcription, audio files are handled as attachments
  bot.on("message:voice", handleVoiceMessage);
  // File handlers
  bot.on("message:document", handleDocumentMessage);
  bot.on("message:photo", handlePhotoMessage);
  bot.on("message:video", handleVideoMessage);
  bot.on("message:audio", handleAudioMessage);
  bot.on("message:sticker", handleStickerMessage);
  bot.on("message:animation", handleAnimationMessage);
  bot.on("message:video_note", handleVideoNoteMessage);

  bot.catch((err) => {
    incrementErrors();
    error("poller", "bot_error", {
      error: err.message || String(err),
    });
  });

  return bot;
}

export async function startPolling(bot: Bot): Promise<void> {
  info("poller", "starting_polling");

  // Start with infinite retry logic with exponential backoff capped at 5 minutes
  let retryCount = 0;
  const baseDelay = 1000;
  const maxDelay = 300000; // 5 minutes

  while (true) {
    try {
      await bot.start({
        onStart: (botInfo) => {
          info("poller", "bot_started", { username: botInfo.username });
          retryCount = 0;
        },
      });
      break;
    } catch (err) {
      retryCount++;
      error("poller", "start_failed", {
        attempt: retryCount,
        error: err instanceof Error ? err.message : String(err),
      });

      // Exponential backoff capped at maxDelay
      const delay = Math.min(baseDelay * Math.pow(2, retryCount - 1), maxDelay);
      info("poller", "retrying", { delayMs: delay, attempt: retryCount });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
