/**
 * Main poller module for the Telegram Gateway bot
 * Handles message processing and bot lifecycle
 */

import * as fs from "fs";
import { Bot, Context } from "grammy";
import {
  runAI,
  getStats,
  getCurrentModel,
  getAIProviderName,
  isSessionStuck,
  isSessionRestarting,
  restartSession,
  getSessionId,
} from "./ai";
import { isAuthFailureText } from "./ai/auth-failure";
import { isDegradedMode } from "./ai/auth-check";
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
  createActionContext,
  buildActionKeyboard,
  buildActionPrompt,
  getLatestActionContextForUser,
  setActionContextAvailableActions,
} from "./interactive-actions";
import { decideResponseActions } from "./action-advisor";
import { buildResponseContextLabel } from "./response-context";
import { buildReplyContextEnvelope, getConversationKeyFromContext } from "./conversation-context";
import {
  downloadTelegramFile,
  formatFileMetadata,
  FileMetadata,
  FileType,
  MAX_DOWNLOAD_SIZE,
} from "./files";
import { registerTopicFromMessage, formatTopicsForContext } from "./topic-registry";

// Fallback messages when the AI provider is unavailable
function getFallbackRestartingMessage(): string {
  const providerName = getProviderDisplayName();
  return `Hold on! ${providerName} is restarting right now \u{1F504} Give it 5-10 seconds and try again!`;
}

function getFallbackStuckMessage(): string {
  const providerName = getProviderDisplayName();
  return `Oops, ${providerName} got stuck on something \u{1F605} Restarting now! Try again in about 10 seconds \u{1F44D}`;
}

const BACKEND_AUTH_ERROR_MESSAGE =
  "Gateway error: AI backend authentication is unavailable right now. Please try again shortly.";

function hasBackendAuthFailure(result: { error?: string; response?: string }): boolean {
  return isAuthFailureText(result.error) || isAuthFailureText(result.response);
}

async function respondBackendAuthFailure(
  ctx: Context,
  streamHandler: StreamingResponseHandler,
  userId: string,
  requestId: string
): Promise<void> {
  streamHandler.cleanup();

  // Do NOT restart the session on auth failure - restarting won't fix auth.
  // Degraded mode is entered by auth-check or self-heal; periodic check recovers.

  const currentMessageId = streamHandler.getCurrentMessageId();
  if (currentMessageId !== null && ctx.chat) {
    try {
      await ctx.api.editMessageText(ctx.chat.id, currentMessageId, BACKEND_AUTH_ERROR_MESSAGE, {
        link_preview_options: { is_disabled: true },
      } as any);
      warn("poller", "backend_auth_failure", { userId, mode: "edit" }, requestId);
      return;
    } catch {
      // Fall back to sending a fresh message.
    }
  }

  await sendErrorResponse(ctx, BACKEND_AUTH_ERROR_MESSAGE, userId);
  warn("poller", "backend_auth_failure", { userId, mode: "reply" }, requestId);
}

/**
 * Generate a unique request ID for tracing
 * Format: req-{timestamp}-{random6chars}
 */
let requestCounter = 0;
function generateRequestId(): string {
  const timestamp = Date.now();
  const count = (requestCounter++).toString(36);
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let random = "";
  for (let i = 0; i < 4; i++) {
    random += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `req-${timestamp}-${count}${random}`;
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

/** Check if the AI backend is currently processing user messages. */
export function isAIBusy(): boolean {
  return aiProcessingCount > 0;
}

/**
 * Atomically check if AI is free and acquire a slot.
 * Returns true if slot was acquired, false if AI was busy.
 * Used by sentinel to prevent races between check and acquire.
 */
export function tryAcquireAISlot(): boolean {
  if (aiProcessingCount > 0) return false;
  aiProcessingCount++;
  return true;
}

/** Release an AI processing slot. */
export function releaseAISlot(): void {
  if (aiProcessingCount > 0) aiProcessingCount--;
}

import {
  handleTimerCallback,
  handleWeatherCallback,
  handleTranslateCallback,
  handleHelpCallback,
  handleWeatherMenuCallback,
  handleTimerMenuCallback,
  handleModelCallback,
  handleSessionCallback,
  handleRebootConfirmCallback,
  handleRebootCancelCallback,
  handleAIActionCallback,
  handleAIContextCallback,
  handleScheduleCallback,
  handleCommandCenterCallback,
} from "./callbacks";

async function attachActionKeyboard(
  ctx: Context,
  messageId: number,
  token: string,
  actions: ("regen" | "short" | "deep")[]
): Promise<void> {
  if (!ctx.chat) return;
  try {
    await ctx.api.editMessageReplyMarkup(ctx.chat.id, messageId, {
      reply_markup: buildActionKeyboard(token, { actions, includeContext: true }),
    });
  } catch {
    // Ignore markup attachment failures (message may be deleted/edited elsewhere)
  }
}

function truncateForDecision(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const clipped = trimmed.slice(0, Math.max(0, maxChars - 13));
  return `${clipped}[truncated]`;
}

async function getModelDecidedActions(prompt: string, response: string): Promise<("regen" | "short" | "deep")[]> {
  const config = getConfig();
  if (!config.responseActions.enabled) {
    return [];
  }

  const decisionPrompt = truncateForDecision(prompt, config.responseActions.maxPromptChars);
  const decisionResponse = truncateForDecision(response, config.responseActions.maxResponseChars);
  return decideResponseActions({
    prompt: decisionPrompt,
    response: decisionResponse,
    model: getCurrentModel(),
    provider: getAIProviderName(),
    timeoutMs: config.responseActions.decisionTimeoutMs,
  });
}

function buildPromptWithReplyContext(
  ctx: Context,
  messageText: string
): string {
  const config = getConfig();
  if (!config.conversation.enableReplyContextInjection) {
    return messageText;
  }
  return buildReplyContextEnvelope(
    ctx,
    messageText,
    config.conversation.replyContextMaxChars
  );
}

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

    // Get conversation-keyed session ID for file storage isolation
    const conversationKey = getConversationKeyFromContext(ctx);
    const sessionId = getSessionId(conversationKey);

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
  const conversationKey = getConversationKeyFromContext(ctx);

  // Register topic info from incoming messages
  if (ctx.chat?.id && ctx.message) {
    registerTopicFromMessage(ctx.chat.id, ctx.message);
  }

  if (!userId || !messageText) {
    return;
  }

  // Reject new messages during deploy drain
  if (isDeployPending()) {
    await ctx.reply("Restarting with a new version. Back in a few seconds!");
    return;
  }

  // Reject messages when auth is broken (degraded mode)
  if (isDegradedMode()) {
    await ctx.reply("AI backend is temporarily unavailable (authentication issue). The admin has been notified - try again shortly.");
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
    const commandToken = parts[0] || "";
    const command = commandToken.split("@")[0].toLowerCase();
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

    if (command === "pair" && isUserAllowed(userId, allowlist)) {
      await ctx.reply("You're already paired and authorized \u{2705} Use /help to see available commands.");
      return;
    }

    // Handle other commands
    if (await handleCommand(ctx, command, args)) {
      return;
    }

    // For authorized users, unknown slash commands should not be sent to AI.
    if (isUserAllowed(userId, allowlist)) {
      await ctx.reply(`I don't recognize /${command}. Use /help for the command list.`);
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
  const interactionCue = messageText.trim().toLowerCase();
  const cueToAction: Record<string, "regen" | "short" | "deep"> = {
    again: "regen",
    regenerate: "regen",
    shorter: "short",
    concise: "short",
    deeper: "deep",
    detail: "deep",
  };
  const cueAction = cueToAction[interactionCue];
  if (cueAction) {
    const latestContext = getLatestActionContextForUser(userId);
    if (latestContext) {
      const interactionPrompt = buildActionPrompt(cueAction, latestContext.prompt);
      await processTextWithClaude(ctx, userId, interactionPrompt, {
        requestId,
        actionBasePrompt: latestContext.prompt,
        contextKey: conversationKey,
      });
      return;
    }
  }

  debug("poller", "processing_message", {
    userId,
    conversationKey,
    length: messageText.length,
    preview: messageText.substring(0, 50),
    activeRequests: aiProcessingCount,
  }, requestId);

  // Check keyed session health for this conversation.
  if (isSessionRestarting(conversationKey)) {
    await ctx.reply(getFallbackRestartingMessage());
    return;
  }

  if (isSessionStuck(conversationKey)) {
    warn("poller", "session_stuck_detected", { userId, conversationKey }, requestId);
    await ctx.reply(getFallbackStuckMessage());
    restartSession(conversationKey).catch((err) => {
      error("poller", "restart_failed", {
        error: err instanceof Error ? err.message : String(err),
        conversationKey,
      }, requestId);
    });
    return;
  }

  inFlightCount++;
  aiProcessingCount++;
  const streamHandler = new StreamingResponseHandler(ctx);
  streamHandler.startTypingIndicator();

  try {
    const config = getConfig();
    const modelInput = buildPromptWithReplyContext(ctx, messageText);
    let prompt = modelInput;

    // Build system prompt if enabled
    if (config.enableSystemPrompt) {
      const stats = getStats(conversationKey);
      const context: SessionContext = {
        messageCount: stats?.messageCount ?? 0,
        recentFailures: stats?.recentFailures ?? 0,
        chatId: ctx.chat?.id,
        chatType: ctx.chat?.type,
        messageThreadId: (ctx.msg as any)?.message_thread_id,
      };
      const memoryContext = loadMemoryContext();
      const topicContext = ctx.chat?.id ? formatTopicsForContext(ctx.chat.id) : "";
      const systemPrompt = buildSystemPrompt(context, memoryContext, {
        providerDisplayName: config.providerDisplayName,
      }, topicContext);
      prompt = wrapWithSystemPrompt(systemPrompt, modelInput);
    }

    const onChunk = async (chunk: string): Promise<void> => {
      await streamHandler.handleChunk(chunk);
    };

    const aiStartTime = Date.now();
    const result = await runAI(prompt, onChunk, conversationKey);
    const responseTimeMs = Date.now() - aiStartTime;

    if (hasBackendAuthFailure(result)) {
      incrementErrors();
      recordFailure("unknown");
      recordSelfHealError("auth_required", result.error || result.response || "auth required");
      await respondBackendAuthFailure(ctx, streamHandler, userId, requestId);
      return;
    }

    incrementMessages();

    if (result.success) {
      recordSuccess();
      trackOutboundMessage(responseTimeMs, result.response.length);
      await streamHandler.finalize();
      const token = createActionContext(userId, messageText, buildResponseContextLabel());
      const availableActions = await getModelDecidedActions(messageText, result.response);
      setActionContextAvailableActions(token, availableActions);
      const messageId = streamHandler.getCurrentMessageId();
      if (messageId) {
        await attachActionKeyboard(ctx, messageId, token, availableActions);
      }
      debug("poller", "message_processed", {
        userId,
        conversationKey,
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
      if (isAuthFailureText(partialText)) {
        await respondBackendAuthFailure(ctx, streamHandler, userId, requestId);
        return;
      }
      const errorMsg = partialText
        ? partialText // Send whatever partial response we got
        : isTimeout
          ? `Whew, that took too long! \u{23F1}\u{FE0F} ${getProviderDisplayName()} got stuck on something complex (over 2 min). The session will auto-restart. Try again, maybe with a simpler request? \u{1F64F}`
          : `Oops, something went wrong \u{1F605} ${result.error || "Unknown error"}. Try rephrasing or send /clear for a fresh start!`;
      await sendErrorResponse(ctx, errorMsg, userId);
      debug("poller", "message_failed", {
        userId,
        conversationKey,
        error: result.error,
        isTimeout,
      }, requestId);
    }
  } catch (err) {
    streamHandler.cleanup();
    incrementErrors();
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (isAuthFailureText(errorMsg)) {
      recordFailure("unknown");
      recordSelfHealError("auth_required", errorMsg);
      await respondBackendAuthFailure(ctx, streamHandler, userId, requestId);
      return;
    }
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
  options?: {
    isVoiceInput?: boolean;
    hasFileAttachment?: boolean;
    requestId?: string;
    actionBasePrompt?: string;
    contextKey?: string;
  }
): Promise<void> {
  const requestId = options?.requestId || generateRequestId();
  const conversationKey = options?.contextKey || getConversationKeyFromContext(ctx);

  // Reject when auth is broken
  if (isDegradedMode()) {
    await sendErrorResponse(ctx, "AI backend is temporarily unavailable (authentication issue). The admin has been notified - try again shortly.", userId);
    return;
  }

  if (isSessionRestarting(conversationKey)) {
    await sendErrorResponse(ctx, getFallbackRestartingMessage(), userId);
    return;
  }

  if (isDeployPending()) {
    await sendErrorResponse(ctx, "Restarting with a new version. Back in a few seconds!", userId);
    return;
  }

  if (isSessionStuck(conversationKey)) {
    warn("poller", "session_stuck_detected", { userId, conversationKey }, requestId);
    await sendErrorResponse(ctx, getFallbackStuckMessage(), userId);
    restartSession(conversationKey).catch((err) => {
      error("poller", "restart_failed", {
        error: err instanceof Error ? err.message : String(err),
        conversationKey,
      }, requestId);
    });
    return;
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
    const modelInput = buildPromptWithReplyContext(ctx, text);
    let prompt = modelInput;

    // Build system prompt if enabled
    if (config.enableSystemPrompt) {
      const stats = getStats(conversationKey);
      const context: SessionContext = {
        messageCount: stats?.messageCount ?? 0,
        recentFailures: stats?.recentFailures ?? 0,
        isVoiceInput: options?.isVoiceInput,
        hasFileAttachment: options?.hasFileAttachment,
        isTTSEnabled: isTTSOutputEnabled(),
        chatId: ctx.chat?.id,
        chatType: ctx.chat?.type,
        messageThreadId: (ctx.msg as any)?.message_thread_id,
      };
      const memoryContext = loadMemoryContext();
      const topicContext = ctx.chat?.id ? formatTopicsForContext(ctx.chat.id) : "";
      const systemPrompt = buildSystemPrompt(context, memoryContext, {
        providerDisplayName: config.providerDisplayName,
      }, topicContext);
      prompt = wrapWithSystemPrompt(systemPrompt, modelInput);
    }

    const onChunk = async (chunk: string): Promise<void> => {
      await streamHandler.handleChunk(chunk);
    };

    const aiStartTime = Date.now();
    const result = await runAI(prompt, onChunk, conversationKey);
    const responseTimeMs = Date.now() - aiStartTime;

    if (hasBackendAuthFailure(result)) {
      incrementErrors();
      recordFailure("unknown");
      recordSelfHealError("auth_required", result.error || result.response || "auth required");
      await respondBackendAuthFailure(ctx, streamHandler, userId, requestId);
      return;
    }

    incrementMessages();

    if (result.success) {
      recordSuccess();
      trackOutboundMessage(responseTimeMs, result.response.length);
      const actionContextPrompt = options?.actionBasePrompt ?? text;
      // For voice input, use sendResponse with TTS; for text, finalize handles it
      if (options?.isVoiceInput) {
        streamHandler.cleanup();
        const replyText = streamHandler.getAccumulatedText().trim() || result.response.trim();
        if (replyText) {
          createActionContext(userId, actionContextPrompt);
          await sendResponse(ctx, {
            text: replyText,
            userId,
            includeAudio: true,
          });
        }
      } else {
        await streamHandler.finalize();
        const token = createActionContext(
          userId,
          actionContextPrompt,
          buildResponseContextLabel()
        );
        const availableActions = await getModelDecidedActions(actionContextPrompt, result.response);
        setActionContextAvailableActions(token, availableActions);
        const messageId = streamHandler.getCurrentMessageId();
        if (messageId) {
          await attachActionKeyboard(ctx, messageId, token, availableActions);
        }
      }
      debug("poller", "message_processed", {
        userId,
        conversationKey,
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
      if (isAuthFailureText(partialText)) {
        await respondBackendAuthFailure(ctx, streamHandler, userId, requestId);
        return;
      }
      const errorMsg = partialText
        ? partialText
        : isTimeout
          ? `Whew, that took too long! \u{23F1}\u{FE0F} ${getProviderDisplayName()} got stuck on something complex (over 2 min). The session will auto-restart. Try again, maybe with a simpler request? \u{1F64F}`
          : `Oops, something went wrong \u{1F605} ${result.error || "Unknown error"}. Try rephrasing or send /clear for a fresh start!`;
      await sendErrorResponse(ctx, errorMsg, userId);
      debug("poller", "message_failed", {
        userId,
        conversationKey,
        error: result.error,
        isTimeout,
      }, requestId);
    }
  } catch (err) {
    streamHandler.cleanup();
    incrementErrors();
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (isAuthFailureText(errorMsg)) {
      recordFailure("unknown");
      recordSelfHealError("auth_required", errorMsg);
      await respondBackendAuthFailure(ctx, streamHandler, userId, requestId);
      return;
    }
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
    // Show typing indicator while transcribing (thread-aware in topics).
    await sendTypingIndicator(ctx);

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
  // Keep this list in sync with handleCommand (src/commands.ts) plus /pair handled in poller.
  if (!skipSetMyCommands) {
    const allChatCommands = [
      { command: "start", description: "Open quick actions" },
      { command: "help", description: "Show all commands" },
      { command: "menu", description: "Open visual command center" },
      { command: "stats", description: "Gateway runtime stats" },
      { command: "clear", description: "Full cleanup + fresh session" },
      { command: "new", description: "Alias of /clear" },
      { command: "id", description: "Show your Telegram ID" },
      { command: "ping", description: "Latency check" },
      { command: "version", description: "Gateway version info" },
      { command: "uptime", description: "Gateway uptime" },
      { command: "model", description: "Switch AI model" },
      { command: "tts", description: "Toggle voice output" },
      { command: "todo", description: "Productivity helper" },
      { command: "remind", description: "Reminder helper" },
      { command: "timer", description: "Quick countdown timer" },
      { command: "weather", description: "Weather info" },
      { command: "define", description: "Define a word" },
      { command: "translate", description: "Translate text" },
      { command: "topic", description: "Manage forum topics (admin)" },
      { command: "group", description: "Group controls and status (admin)" },
      { command: "tg", description: "Call any Telegram Bot API method (admin)" },
      { command: "disk", description: "Disk usage" },
      { command: "memory", description: "Memory usage" },
      { command: "cpu", description: "CPU info" },
      { command: "battery", description: "Battery status" },
      { command: "cd", description: "Change work directory" },
      { command: "ls", description: "List files" },
      { command: "pwd", description: "Show working directory" },
      { command: "cat", description: "Show file content" },
      { command: "find", description: "Find files by name" },
      { command: "size", description: "Show path size" },
      { command: "curl", description: "Fetch URL content" },
      { command: "schedule", description: "Open schedule manager" },
      { command: "sentinel", description: "Proactive monitoring" },
      { command: "health", description: "System health" },
      { command: "analytics", description: "Usage analytics" },
      { command: "errors", description: "Recent errors" },
      { command: "ps", description: "List processes" },
      { command: "kill", description: "Kill process by PID" },
      { command: "pm2", description: "PM2 process controls" },
      { command: "git", description: "Git quick commands" },
      { command: "net", description: "Network diagnostics" },
      { command: "temp", description: "Temperature info" },
      { command: "top", description: "Top CPU processes" },
      { command: "sh", description: "Run shell command" },
      { command: "session", description: "Manage AI sessions" },
      { command: "reboot", description: "Reboot host system" },
      { command: "pair", description: "Pair this Telegram user" },
    ] as const;

    await bot.api.setMyCommands(allChatCommands);
    await bot.api.setMyCommands(allChatCommands, {
      scope: { type: "all_private_chats" },
    });
    await bot.api.setMyCommands(allChatCommands, {
      scope: { type: "all_group_chats" },
    });

    // Improve first-run UX in Telegram with richer bot profile metadata.
    await bot.api.setMyDescription(
      "AI Telegram gateway for chat, files, voice, and system workflows."
    );
    await bot.api.setMyShortDescription(
      "Chat with your AI gateway"
    );
    await bot.api.setChatMenuButton({
      menu_button: { type: "commands" },
    });
  }

  // Register callback query handlers
  bot.callbackQuery(/^timer_\d+$/, handleTimerCallback);
  bot.callbackQuery("timer_menu", handleTimerMenuCallback);
  bot.callbackQuery("weather_menu", handleWeatherMenuCallback);
  bot.callbackQuery(/^cnav_.+$/, handleCommandCenterCallback);
  bot.callbackQuery(/^cmd_.+$/, handleCommandCenterCallback);
  bot.callbackQuery(/^weather_.+$/, handleWeatherCallback);
  bot.callbackQuery(/^translate_.+$/, handleTranslateCallback);
  bot.callbackQuery("help_show", handleHelpCallback);
  bot.callbackQuery(/^model_\w+$/, handleModelCallback);
  bot.callbackQuery(/^session_(status|kill|new)$/, handleSessionCallback);
  bot.callbackQuery("reboot_confirm", handleRebootConfirmCallback);
  bot.callbackQuery("reboot_cancel", handleRebootCancelCallback);
  bot.callbackQuery(/^sched_.+$/, handleScheduleCallback);
  bot.callbackQuery(/^ai_ctx_[a-z0-9]+$/, handleAIContextCallback);
  bot.callbackQuery(/^ai_(regen|short|deep)_[a-z0-9]+$/, handleAIActionCallback);

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
    const errObj = err.error || err;
    const errMsg = errObj instanceof Error ? errObj.message : String(errObj);
    // Don't log noisy "not modified" errors from editing messages
    if (errMsg.includes("message is not modified")) {
      debug("poller", "bot_error_benign", { error: errMsg });
      return;
    }
    error("poller", "bot_error", {
      error: errMsg,
      chatId: err.ctx?.chat?.id,
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
      const errMsg = err instanceof Error ? err.message : String(err);

      // Check for fatal errors that shouldn't be retried
      if (errMsg.includes("401") || errMsg.includes("Unauthorized")) {
        error("poller", "fatal_auth_error", { error: errMsg });
        throw new Error("Bot token is invalid or revoked. Cannot start polling.");
      }

      error("poller", "start_failed", {
        attempt: retryCount,
        error: errMsg,
      });

      // Exponential backoff with jitter, capped at maxDelay
      const jitter = Math.random() * 1000;
      const delay = Math.min(baseDelay * Math.pow(2, retryCount - 1) + jitter, maxDelay);
      info("poller", "retrying", { delayMs: Math.round(delay), attempt: retryCount });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
