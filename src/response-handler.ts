/**
 * Response handler with optional TTS integration
 * Sends text responses and optionally generates audio output
 */

import * as fs from "fs";
import * as path from "path";
import { Context, InputFile } from "grammy";
import { convert } from "telegram-markdown-v2";
import { getConfig } from "./config";
import { generateAudio, isTTSAvailable, isTTSOutputEnabled } from "./tts";
import { info, error as logError, debug, warn } from "./logger";
import {
  parseFileSendRequest,
  removeFileTags,
  isImageMimeType,
  isVideoMimeType,
  isAudioMimeType,
  getMimeTypeFromFilename,
  FileSendRequest,
  validateFileSendPath,
} from "./files";
import { loadAllowlist, isAdminUser } from "./storage";
import { getCurrentModel, getStats as getAIStats } from "./ai";
import * as os from "os";

/** Format token count as compact string (e.g. 12k, 150k) */
function formatTokens(n: number): string {
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}

/** Build a small context footer for AI responses */
function buildContextFooter(): string {
  const stats = getAIStats();
  const cwd = process.cwd();
  const home = os.homedir();
  let short: string;
  if (cwd === home) {
    short = "~";
  } else {
    const displayCwd = cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
    short = displayCwd.split("/").slice(-2).join("/");
  }

  let contextPart: string;
  if (stats?.totalInputTokens && stats.contextWindow) {
    const used = stats.totalInputTokens + (stats.totalOutputTokens || 0);
    contextPart = `${formatTokens(used)}/${formatTokens(stats.contextWindow)}`;
  } else {
    contextPart = getCurrentModel();
  }

  return `\n\n\u2014\n${contextPart} \u00b7 ${short}`;
}

/** Convert standard markdown to Telegram MarkdownV2 format */
function toTelegramMarkdown(text: string): string {
  try {
    return convert(text);
  } catch {
    // If conversion fails, escape all special chars for MarkdownV2
    return text.replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, "\\$1");
  }
}

function buildReplyOptions(
  ctx: Context,
  options?: { quote?: boolean; disableLinkPreview?: boolean }
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    allow_sending_without_reply: true,
  };

  if (options?.disableLinkPreview !== false) {
    result.link_preview_options = { is_disabled: true };
  }

  const msg = ctx.msg as (Context["msg"] & { message_thread_id?: number }) | undefined;
  if (msg?.message_thread_id) {
    result.message_thread_id = msg.message_thread_id;
  }

  if (options?.quote !== false && msg?.message_id) {
    result.reply_parameters = {
      message_id: msg.message_id,
      allow_sending_without_reply: true,
    };
  }

  return result;
}

/**
 * Streaming response handler that edits a single message as chunks arrive
 * Handles typing indicator refresh, throttled edits, and overflow
 */
export class StreamingResponseHandler {
  private ctx: Context;
  private typingInterval: NodeJS.Timeout | null = null;
  private currentMessageId: number | null = null;
  private accumulatedText: string = "";
  private lastSentText: string = "";
  private editCount: number = 0;
  private lastEditTime: number = 0;
  private pendingEditTimeout: NodeJS.Timeout | null = null;
  private editInProgress: Promise<void> | null = null;
  private accumulateOnly: boolean = false;
  private initialReplySent: boolean = false;

  // Constants
  private readonly TYPING_INTERVAL_MS = 4000;
  private readonly EDIT_THROTTLE_MS = 2000;
  private readonly MAX_MESSAGE_LENGTH = 3500;
  private readonly MAX_EDITS = 25;

  constructor(ctx: Context, options?: { accumulateOnly?: boolean }) {
    this.ctx = ctx;
    this.accumulateOnly = options?.accumulateOnly ?? false;
  }

  startTypingIndicator(): void {
    // Send immediately, then start interval
    this.ctx.replyWithChatAction("typing").catch(() => {});
    this.typingInterval = setInterval(() => {
      this.ctx.replyWithChatAction("typing").catch(() => {});
    }, this.TYPING_INTERVAL_MS);
    // Don't prevent process exit
    if (this.typingInterval && typeof this.typingInterval.unref === "function") {
      this.typingInterval.unref();
    }
  }

  stopTypingIndicator(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  async handleChunk(chunk: string): Promise<void> {
    debug("streaming", "chunk_received", { chunkLength: chunk.length, totalLength: this.accumulatedText.length + chunk.length });

    if (!chunk) {
      return;
    }

    // Accumulate text
    // In accumulate-only mode, just collect text without sending
    if (this.accumulateOnly) {
      this.accumulatedText += chunk;
      return;
    }

    // Stop typing on first chunk (when no message exists yet)
    if (this.currentMessageId === null) {
      this.stopTypingIndicator();
    }

    let remaining = chunk;

    while (remaining.length > 0) {
      // Roll over to a new Telegram message once max edits is reached.
      if (this.currentMessageId !== null && this.editCount >= this.MAX_EDITS) {
        await this.finalizeCurrentMessage();
        this.resetCurrentMessageState();
      }

      const available = this.MAX_MESSAGE_LENGTH - this.accumulatedText.length;
      if (available <= 0) {
        await this.finalizeCurrentMessage();
        this.resetCurrentMessageState();
        continue;
      }

      const nextChunkPart = remaining.slice(0, available);
      this.accumulatedText += nextChunkPart;
      remaining = remaining.slice(nextChunkPart.length);

      // Boundary split: flush exactly this full message, then continue with the rest.
      if (remaining.length > 0) {
        await this.finalizeCurrentMessage();
        this.resetCurrentMessageState();
      }
    }

    // Schedule throttled edit
    this.scheduleEdit();
  }

  private resetCurrentMessageState(): void {
    this.currentMessageId = null;
    this.accumulatedText = "";
    this.lastSentText = "";
    this.editCount = 0;
    this.lastEditTime = 0;
  }

  private scheduleEdit(): void {
    // Clear any pending edit
    if (this.pendingEditTimeout) {
      clearTimeout(this.pendingEditTimeout);
    }

    const now = Date.now();
    const timeSinceLastEdit = now - this.lastEditTime;
    const delay = Math.max(0, this.EDIT_THROTTLE_MS - timeSinceLastEdit);

    this.pendingEditTimeout = setTimeout(() => {
      this.performEdit().catch((err) => {
        logError("streaming", "scheduled_edit_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delay);
    // Don't prevent process exit during graceful shutdown
    if (this.pendingEditTimeout && typeof this.pendingEditTimeout.unref === "function") {
      this.pendingEditTimeout.unref();
    }
  }

  private async performEdit(): Promise<void> {
    // Wait for any in-progress edit to complete
    if (this.editInProgress) {
      await this.editInProgress;
    }

    if (!this.accumulatedText) return;

    // Mark edit as in progress
    this.editInProgress = this.doPerformEdit();
    await this.editInProgress;
    this.editInProgress = null;
  }

  private async doPerformEdit(): Promise<void> {
    // Skip if content unchanged
    if (this.accumulatedText === this.lastSentText) {
      return;
    }

    try {
      if (this.currentMessageId === null) {
        // First chunk - send new message
        debug("streaming", "sending_first_message", { length: this.accumulatedText.length });
        const msg = await this.sendWithMarkdown(this.accumulatedText);
        this.currentMessageId = msg.message_id;
        this.lastSentText = this.accumulatedText;
        debug("streaming", "first_message_sent", { messageId: this.currentMessageId });
      } else {
        // Subsequent chunks - edit existing message
        debug("streaming", "editing_message", { messageId: this.currentMessageId, length: this.accumulatedText.length, editCount: this.editCount });
        await this.editWithMarkdown(
          this.ctx.chat!.id,
          this.currentMessageId,
          this.accumulatedText
        );
        this.lastSentText = this.accumulatedText;
        this.editCount++;
      }
      this.lastEditTime = Date.now();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logError("streaming", "edit_failed", { error: errMsg, currentMessageId: this.currentMessageId });
      // Edit failed - fall back to new message only if we haven't sent anything yet
      if (this.currentMessageId === null) {
        try {
          const msg = await this.sendWithMarkdown(this.accumulatedText);
          this.currentMessageId = msg.message_id;
          this.lastSentText = this.accumulatedText;
          this.editCount = 0;
          debug("streaming", "fallback_message_sent", { messageId: this.currentMessageId });
        } catch (fallbackErr: unknown) {
          const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          logError("streaming", "fallback_message_failed", { error: fallbackMsg });
        }
      }
      // If edit failed but we already have a message, just log and continue (content already sent)
    }
  }

  private async finalizeCurrentMessage(): Promise<void> {
    // Clear pending timeout
    if (this.pendingEditTimeout) {
      clearTimeout(this.pendingEditTimeout);
      this.pendingEditTimeout = null;
    }

    // Flush latest accumulated content before any rollover/finalization.
    await this.performEdit();
  }

  async finalize(): Promise<void> {
    // Clear pending timeout
    if (this.pendingEditTimeout) {
      clearTimeout(this.pendingEditTimeout);
      this.pendingEditTimeout = null;
    }

    // Perform final edit
    await this.performEdit();

    // Append context footer
    if (this.currentMessageId !== null && !this.accumulateOnly) {
      const footer = buildContextFooter();
      this.accumulatedText += footer;
      this.lastSentText = ""; // Force re-edit
      await this.performEdit();
    }

    // Process any <send-file> tags in the accumulated text
    await this.processFileTags();

    // Cleanup
    this.cleanup();
  }

  /**
   * Process <send-file> tags in accumulated text - send files and update message
   */
  private async processFileTags(): Promise<void> {
    if (!this.accumulatedText) return;

    const fileSendRequests = parseFileSendRequest(this.accumulatedText);
    if (fileSendRequests.length === 0) return;

    // Send each requested file
    for (const fileRequest of fileSendRequests) {
      await this.sendFile(fileRequest);
    }

    // Remove file tags from the message text
    const cleanedText = removeFileTags(this.accumulatedText);

    // Update the message to remove the file tags (if we have a message and text changed)
    if (this.currentMessageId !== null && cleanedText !== this.accumulatedText) {
      try {
        if (cleanedText.trim()) {
          await this.editWithMarkdown(
            this.ctx.chat!.id,
            this.currentMessageId,
            cleanedText
          );
        } else {
          // If only file tags were in the message, delete it
          await this.ctx.api.deleteMessage(this.ctx.chat!.id, this.currentMessageId);
        }
      } catch {
        // Ignore edit failures - file was still sent
      }
    }
  }

  /**
   * Send a single file to the user
   */
  private async sendFile(fileRequest: FileSendRequest): Promise<void> {
    try {
      const userId = this.ctx.from?.id?.toString();
      const allowlist = await loadAllowlist();
      if (!userId || !isAdminUser(userId, allowlist)) {
        warn("streaming", "file_send_blocked_non_admin", {
          requestedPath: fileRequest.path,
          userId: userId ?? "unknown",
        });
        await this.ctx.reply("File sending is restricted to the admin.");
        return;
      }

      const pathValidation = validateFileSendPath(fileRequest.path);
      if (!pathValidation.ok || !pathValidation.resolvedPath) {
        warn("streaming", "file_send_blocked_invalid_path", {
          requestedPath: fileRequest.path,
          reason: pathValidation.reason ?? "unknown",
        });
        await this.ctx.reply(`Blocked unsafe file path: ${path.basename(fileRequest.path)}`);
        return;
      }

      const safePath = pathValidation.resolvedPath;

      // Validate file size before sending
      const stats = fs.statSync(safePath);
      const MAX_SEND_SIZE = 50 * 1024 * 1024; // 50MB

      if (stats.size > MAX_SEND_SIZE) {
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
        await this.ctx.reply(`File too large (${sizeMB}MB). Telegram limit is 50MB.`);
        return;
      }

      const filename = path.basename(safePath);
      const mimeType = getMimeTypeFromFilename(filename);
      const inputFile = new InputFile(safePath, filename);

      debug("streaming", "sending_file", {
        path: safePath,
        mimeType,
        caption: fileRequest.caption,
      });

      // Send as appropriate type based on MIME
      if (isImageMimeType(mimeType)) {
        await this.ctx.replyWithPhoto(inputFile, {
          ...buildReplyOptions(this.ctx, { quote: false }),
          caption: fileRequest.caption,
        } as any);
      } else if (isVideoMimeType(mimeType)) {
        await this.ctx.replyWithVideo(inputFile, {
          ...buildReplyOptions(this.ctx, { quote: false }),
          caption: fileRequest.caption,
        } as any);
      } else if (isAudioMimeType(mimeType)) {
        await this.ctx.replyWithAudio(inputFile, {
          ...buildReplyOptions(this.ctx, { quote: false }),
          caption: fileRequest.caption,
        } as any);
      } else {
        await this.ctx.replyWithDocument(inputFile, {
          ...buildReplyOptions(this.ctx, { quote: false }),
          caption: fileRequest.caption,
        } as any);
      }

      info("streaming", "file_sent", { path: safePath });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      let userMessage = `Failed to send file: ${path.basename(fileRequest.path)}`;

      if (errorMsg.includes("file is too big")) {
        userMessage = "File exceeds Telegram's size limit";
      } else if (errorMsg.includes("MEDIA_EMPTY")) {
        userMessage = "File appears empty or corrupted";
      }

      await this.ctx.reply(userMessage);
      logError("streaming", "file_send_failed", { path: fileRequest.path, error: errorMsg });
    }
  }

  /** Check if a Telegram error is retryable (rate limit, server error) */
  private isRetryableError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message;
    // Telegram rate limiting (429)
    if (msg.includes("429") || msg.includes("Too Many Requests") || msg.includes("retry after")) return true;
    // Telegram server errors (5xx)
    if (/5\d\d/.test(msg)) return true;
    // Network errors
    if (msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("network")) return true;
    return false;
  }

  /** Retry a Telegram API call once after a short delay for transient errors */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (this.isRetryableError(err)) {
        // Wait 1-2 seconds for rate limits
        const delay = err instanceof Error && err.message.includes("retry after")
          ? 2000
          : 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        return await fn();
      }
      throw err;
    }
  }

  /** Send message with MarkdownV2 parse mode, fallback to plain text */
  private async sendWithMarkdown(text: string): Promise<{ message_id: number }> {
    const safeText = this.clipForTelegram(text);
    const markdownText = toTelegramMarkdown(safeText);
    const replyOptions = buildReplyOptions(this.ctx, {
      quote: !this.initialReplySent,
      disableLinkPreview: true,
    });
    try {
      if (markdownText.length <= 4096) {
        const sent = await this.withRetry(() => this.ctx.reply(markdownText, {
          ...replyOptions,
          parse_mode: "MarkdownV2",
        } as any));
        this.initialReplySent = true;
        return sent;
      }
      const sent = await this.withRetry(() => this.ctx.reply(safeText, replyOptions as any));
      this.initialReplySent = true;
      return sent;
    } catch {
      const sent = await this.withRetry(() => this.ctx.reply(safeText, replyOptions as any));
      this.initialReplySent = true;
      return sent;
    }
  }

  /** Edit message with MarkdownV2 parse mode, fallback to plain text */
  private async editWithMarkdown(chatId: number, messageId: number, text: string): Promise<void> {
    const safeText = this.clipForTelegram(text);
    const markdownText = toTelegramMarkdown(safeText);
    try {
      if (markdownText.length <= 4096) {
        await this.withRetry(() => this.ctx.api.editMessageText(chatId, messageId, markdownText, {
          parse_mode: "MarkdownV2",
          link_preview_options: { is_disabled: true },
        } as any));
      } else {
        await this.withRetry(() => this.ctx.api.editMessageText(chatId, messageId, safeText, {
          link_preview_options: { is_disabled: true },
        } as any));
      }
    } catch {
      try {
        await this.ctx.api.editMessageText(chatId, messageId, safeText, {
          link_preview_options: { is_disabled: true },
        } as any);
      } catch {
        // If even plain text edit fails, silently give up (message content was already partially sent)
      }
    }
  }

  private clipForTelegram(text: string): string {
    if (text.length <= this.MAX_MESSAGE_LENGTH) {
      return text;
    }
    return `${text.slice(0, this.MAX_MESSAGE_LENGTH - 3)}...`;
  }

  cleanup(): void {
    this.stopTypingIndicator();
    if (this.pendingEditTimeout) {
      clearTimeout(this.pendingEditTimeout);
      this.pendingEditTimeout = null;
    }
  }

  /** Get accumulated text (for TTS or other post-processing) */
  getAccumulatedText(): string {
    return this.accumulatedText;
  }
}

export interface SendResponseOptions {
  text: string;
  includeAudio?: boolean;
  userId?: string;
  skipFooter?: boolean;
}

/**
 * Send response - either audio only (for voice input) or text only
 * No duplication: voice input = voice response, text input = text response
 */
export async function sendResponse(
  ctx: Context,
  options: SendResponseOptions
): Promise<void> {
  const config = getConfig();
  const { text, includeAudio = false, userId, skipFooter = false } = options;

  if (!text || text.trim().length === 0) {
    await ctx.reply("(empty response)", buildReplyOptions(ctx) as any);
    return;
  }

  // Voice response: send audio only (no text)
  // Requires: voice input flag, runtime TTS enabled, and TTS service available
  if (includeAudio && isTTSOutputEnabled() && (await isTTSAvailable())) {
    try {
      debug("response", "generating_audio", { userId, textLength: text.length });

      const audioResult = await generateAudio(text);

      if (!audioResult.success || !audioResult.audioPath) {
        debug("response", "audio_generation_failed", {
          userId,
          error: audioResult.error,
        });
        // Fall back to text if audio generation fails
        await ctx.reply(`[Voice unavailable] ${text}`, buildReplyOptions(ctx) as any);
        return;
      }

      // Verify file exists
      if (!fs.existsSync(audioResult.audioPath)) {
        logError("response", "audio_file_not_found", {
          userId,
          path: audioResult.audioPath,
        });
        await ctx.reply(`[Voice unavailable] ${text}`, buildReplyOptions(ctx) as any);
        return;
      }

      // Send audio only
      debug("response", "sending_audio", {
        userId,
        audioSize: fs.statSync(audioResult.audioPath).size,
        durationMs: audioResult.durationMs,
      });

      const audioFile = new InputFile(audioResult.audioPath, "response.ogg");
      try {
        await ctx.replyWithChatAction("upload_voice");
        await ctx.replyWithAudio(audioFile, buildReplyOptions(ctx) as any);
      } catch (audioErr: unknown) {
        if (audioErr instanceof Error && audioErr.message?.includes("VOICE_MESSAGES_FORBIDDEN")) {
          debug("response", "audio_blocked_trying_document", { userId });
          const docFile = new InputFile(audioResult.audioPath, "response.ogg");
          await ctx.replyWithChatAction("upload_document");
          await ctx.replyWithDocument(docFile, buildReplyOptions(ctx) as any);
        } else {
          throw audioErr;
        }
      }

      // Clean up audio file
      try {
        fs.unlinkSync(audioResult.audioPath);
      } catch {
        // Ignore cleanup errors
      }

      info("response", "audio_sent", {
        userId,
        durationMs: audioResult.durationMs,
      });
      return;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logError("response", "audio_send_failed", { userId, error: errorMsg });
      // Fall back to text
      await ctx.reply(`[Voice unavailable] ${text}`, buildReplyOptions(ctx) as any);
      return;
    }
  }

  // Check for file send requests in the response
  const fileSendRequests = parseFileSendRequest(text);
  let remainingText = fileSendRequests.length > 0 ? removeFileTags(text) : text;

  // Send any requested files first
  for (const fileRequest of fileSendRequests) {
    try {
      if (!fs.existsSync(fileRequest.path)) {
        debug("response", "file_not_found", { path: fileRequest.path });
        continue;
      }

      const filename = path.basename(fileRequest.path);
      const mimeType = getMimeTypeFromFilename(filename);
      const inputFile = new InputFile(fileRequest.path, filename);

      debug("response", "sending_file", {
        path: fileRequest.path,
        mimeType,
        caption: fileRequest.caption,
      });

      // Send as appropriate type based on MIME
      if (isImageMimeType(mimeType)) {
        await ctx.replyWithChatAction("upload_photo");
        await ctx.replyWithPhoto(inputFile, {
          ...buildReplyOptions(ctx, { quote: false }),
          caption: fileRequest.caption,
        } as any);
      } else if (isVideoMimeType(mimeType)) {
        await ctx.replyWithChatAction("upload_video");
        await ctx.replyWithVideo(inputFile, {
          ...buildReplyOptions(ctx, { quote: false }),
          caption: fileRequest.caption,
        } as any);
      } else if (isAudioMimeType(mimeType)) {
        await ctx.replyWithChatAction("upload_voice");
        await ctx.replyWithAudio(inputFile, {
          ...buildReplyOptions(ctx, { quote: false }),
          caption: fileRequest.caption,
        } as any);
      } else {
        await ctx.replyWithChatAction("upload_document");
        await ctx.replyWithDocument(inputFile, {
          ...buildReplyOptions(ctx, { quote: false }),
          caption: fileRequest.caption,
        } as any);
      }

      info("response", "file_sent", { path: fileRequest.path, userId });
    } catch (err) {
      logError("response", "file_send_failed", {
        path: fileRequest.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Text response: send remaining text only if there's content
  if (remainingText && remainingText.trim().length > 0) {
    const fullText = skipFooter ? remainingText : remainingText + buildContextFooter();
    try {
      await ctx.reply(toTelegramMarkdown(fullText), {
        ...buildReplyOptions(ctx),
        parse_mode: "MarkdownV2",
      } as any);
    } catch {
      await ctx.reply(fullText, buildReplyOptions(ctx) as any);
    }
  }
}

/**
 * Send error response
 */
export async function sendErrorResponse(ctx: Context, error: string, userId?: string): Promise<void> {
  const text = error || "An error occurred processing your request.";
  await sendResponse(ctx, { text, includeAudio: false, userId, skipFooter: true });
}

/**
 * Send typing indicator
 */
export async function sendTypingIndicator(ctx: Context): Promise<void> {
  try {
    await ctx.replyWithChatAction("typing");
  } catch {
    // Ignore failures
  }
}
