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
import {
  executeTelegramApiTags,
  removeTelegramApiTags,
} from "./telegram-api-executor";

type MessageWithTopicContext = Context["msg"] & {
  message_thread_id?: number;
  is_topic_message?: boolean;
};

function getMessageThreadId(ctx: Context): number | undefined {
  const msg = getTopicMessage(ctx);
  if (typeof msg?.message_thread_id === "number" && msg.message_thread_id > 0) {
    return msg.message_thread_id;
  }
  return undefined;
}

async function sendChatActionWithThreadContext(ctx: Context, action: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined || chatId === null) {
    return;
  }
  const messageThreadId = getMessageThreadId(ctx);
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    action,
  };
  if (messageThreadId !== undefined) {
    payload.message_thread_id = messageThreadId;
  }
  await ctx.api.raw.sendChatAction(payload as any);
}

function getTopicMessage(ctx: Context): MessageWithTopicContext | undefined {
  return ctx.msg as MessageWithTopicContext | undefined;
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

function hasTelegramApiErrors(summaryLines: string[]): boolean {
  return summaryLines.some((line) => line.includes(": ERROR"));
}

function appendTelegramApiFailureNote(text: string): string {
  const note = "I couldn't apply one or more Telegram changes. I can retry with a safer fallback.";
  const base = text.trim();
  if (!base) return note;
  if (base.includes(note)) return base;
  return `${base}\n\n${note}`;
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

  const msg = getTopicMessage(ctx);
  if (typeof msg?.message_thread_id === "number" && msg.message_thread_id > 0) {
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

function isDraftEligible(ctx: Context): boolean {
  const msg = getTopicMessage(ctx);
  if (!msg) return false;
  if (ctx.chat?.type !== "private") return false;
  return typeof msg.message_thread_id === "number" && msg.message_thread_id > 0;
}

function buildDraftOptions(ctx: Context, draftId: number): Record<string, unknown> {
  const options: Record<string, unknown> = { draft_id: draftId };
  const msg = getTopicMessage(ctx);
  if (typeof msg?.message_thread_id === "number" && msg.message_thread_id > 0) {
    options.message_thread_id = msg.message_thread_id;
  }
  return options;
}

/**
 * Streaming response handler that edits a single message as chunks arrive
 * Handles typing indicator refresh, throttled edits, and overflow
 */
export class StreamingResponseHandler {
  private ctx: Context;
  private typingInterval: NodeJS.Timeout | null = null;
  private typingRunning: boolean = false;
  private typingInFlight: boolean = false;
  private lastTypingSentAt: number = 0;
  private currentMessageId: number | null = null;
  private accumulatedText: string = "";
  private lastSentText: string = "";
  private editCount: number = 0;
  private lastEditTime: number = 0;
  private pendingEditTimeout: NodeJS.Timeout | null = null;
  private editInProgress: Promise<void> | null = null;
  private pendingDraftTimeout: NodeJS.Timeout | null = null;
  private draftInProgress: Promise<void> | null = null;
  private draftEnabled: boolean = false;
  private draftId: number = 0;
  private lastDraftText: string = "";
  private lastDraftTime: number = 0;
  private accumulateOnly: boolean = false;
  private initialReplySent: boolean = false;

  // Constants
  private readonly TYPING_REFRESH_MS = 4500;
  private readonly TYPING_MIN_GAP_MS = 1000;
  private readonly EDIT_THROTTLE_MS = 2000;
  private readonly DRAFT_THROTTLE_MS = 900;
  private readonly MAX_MESSAGE_LENGTH = 3500;
  private readonly MAX_DRAFT_LENGTH = 4096;
  private readonly MAX_EDITS = 25;

  constructor(ctx: Context, options?: { accumulateOnly?: boolean }) {
    this.ctx = ctx;
    this.accumulateOnly = options?.accumulateOnly ?? false;
    this.draftId = Math.max(1, Math.floor((Date.now() + Math.random() * 100000) % 2147483647));
    this.draftEnabled = !this.accumulateOnly && isDraftEligible(ctx);
  }

  startTypingIndicator(): void {
    if (this.typingRunning) return;
    this.typingRunning = true;

    // Send immediately, then continue with precise non-overlapping refreshes.
    void this.sendTypingPulse(true);
    this.scheduleNextTypingPulse();
  }

  stopTypingIndicator(): void {
    this.typingRunning = false;
    if (this.typingInterval) {
      clearTimeout(this.typingInterval);
      this.typingInterval = null;
    }
  }

  private scheduleNextTypingPulse(): void {
    if (!this.typingRunning) return;

    this.typingInterval = setTimeout(() => {
      this.sendTypingPulse().finally(() => {
        this.scheduleNextTypingPulse();
      });
    }, this.TYPING_REFRESH_MS);

    // Don't prevent process exit
    if (this.typingInterval && typeof this.typingInterval.unref === "function") {
      this.typingInterval.unref();
    }
  }

  private async sendTypingPulse(force: boolean = false): Promise<void> {
    if (!this.typingRunning || this.typingInFlight) return;

    const now = Date.now();
    if (!force && now - this.lastTypingSentAt < this.TYPING_MIN_GAP_MS) {
      return;
    }

    this.typingInFlight = true;
    try {
      await sendChatActionWithThreadContext(this.ctx, "typing");
      this.lastTypingSentAt = Date.now();
    } catch {
      // Ignore failures
    } finally {
      this.typingInFlight = false;
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

    // Schedule throttled draft updates for topic-enabled private chats.
    this.scheduleDraft();

    // Schedule throttled edit
    this.scheduleEdit();
  }

  private resetCurrentMessageState(): void {
    this.currentMessageId = null;
    this.accumulatedText = "";
    this.lastSentText = "";
    this.editCount = 0;
    this.lastEditTime = 0;
    this.draftId = Math.max(1, Math.floor((Date.now() + Math.random() * 100000) % 2147483647));
    this.lastDraftText = "";
    this.lastDraftTime = 0;
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

  private scheduleDraft(): void {
    if (!this.draftEnabled) return;

    if (this.pendingDraftTimeout) {
      clearTimeout(this.pendingDraftTimeout);
    }

    const now = Date.now();
    const timeSinceLastDraft = now - this.lastDraftTime;
    const delay = Math.max(0, this.DRAFT_THROTTLE_MS - timeSinceLastDraft);

    this.pendingDraftTimeout = setTimeout(() => {
      this.performDraft().catch((err) => {
        logError("streaming", "scheduled_draft_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delay);

    if (this.pendingDraftTimeout && typeof this.pendingDraftTimeout.unref === "function") {
      this.pendingDraftTimeout.unref();
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
    await this.performDraft(true);
    await this.performEdit();
  }

  async finalize(): Promise<void> {
    // Clear pending timeout
    if (this.pendingEditTimeout) {
      clearTimeout(this.pendingEditTimeout);
      this.pendingEditTimeout = null;
    }
    if (this.pendingDraftTimeout) {
      clearTimeout(this.pendingDraftTimeout);
      this.pendingDraftTimeout = null;
    }

    // Perform final edit
    await this.performDraft(true);
    await this.performEdit();

    // Process any <telegram-api> tags first so text clean-up applies before file dispatch.
    await this.processTelegramApiTags();

    // Process any <send-file> tags in the accumulated text
    await this.processFileTags();

    // Cleanup
    this.cleanup();
  }

  private async processTelegramApiTags(): Promise<void> {
    if (!this.accumulatedText) return;

    const userId = this.ctx.from?.id?.toString();
    const allowlist = await loadAllowlist();
    const isAdmin = userId ? isAdminUser(userId, allowlist) : false;
    const msg = this.ctx.msg as { message_thread_id?: number } | undefined;
    const execution = await executeTelegramApiTags(this.ctx.api, this.accumulatedText, {
      callerType: "model_tag",
      userId,
      isAdmin,
      chatId: this.ctx.chat?.id,
      messageThreadId: typeof msg?.message_thread_id === "number" ? msg.message_thread_id : undefined,
    });

    if (!execution.hadTags) {
      return;
    }

    const cleanedText = execution.cleanedText;
    if (execution.summaryLines.length > 0) {
      info("streaming", "telegram_api_actions_executed", {
        count: execution.summaryLines.length,
        summary: execution.summaryLines.join(" | "),
      });
    }
    const hadApiErrors = hasTelegramApiErrors(execution.summaryLines);
    let visibleText = removeFileTags(cleanedText).trim();
    if (hadApiErrors) {
      visibleText = appendTelegramApiFailureNote(visibleText);
    }

    if (!visibleText) {
      // No visible model text after tag cleanup - delete placeholder message.
      if (this.currentMessageId !== null && this.ctx.chat) {
        try {
          await this.ctx.api.deleteMessage(this.ctx.chat.id, this.currentMessageId);
        } catch {
          // Ignore cleanup failure.
        }
      }
      this.accumulatedText = "";
      return;
    }

    this.accumulatedText = cleanedText;

    if (this.currentMessageId !== null && this.ctx.chat) {
      await this.editWithMarkdown(this.ctx.chat.id, this.currentMessageId, visibleText);
    } else {
      const sent = await this.sendWithMarkdown(visibleText);
      this.currentMessageId = sent.message_id;
    }
    this.lastSentText = visibleText;
  }

  private async performDraft(force: boolean = false): Promise<void> {
    if (!this.draftEnabled) return;

    if (this.draftInProgress) {
      await this.draftInProgress;
    }

    if (!this.accumulatedText) return;

    if (!force) {
      const now = Date.now();
      if (now - this.lastDraftTime < this.DRAFT_THROTTLE_MS) return;
    }

    this.draftInProgress = this.doPerformDraft();
    await this.draftInProgress;
    this.draftInProgress = null;
  }

  private async doPerformDraft(): Promise<void> {
    if (!this.draftEnabled) return;

    const safeText = this.accumulatedText.length <= this.MAX_DRAFT_LENGTH
      ? this.accumulatedText
      : `${this.accumulatedText.slice(0, this.MAX_DRAFT_LENGTH - 3)}...`;

    if (!safeText || safeText === this.lastDraftText) {
      return;
    }

    try {
      await this.withRetry(() => this.ctx.replyWithDraft(safeText, buildDraftOptions(this.ctx, this.draftId) as any));
      this.lastDraftText = safeText;
      this.lastDraftTime = Date.now();
      debug("streaming", "draft_updated", { draftId: this.draftId, length: safeText.length });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Draft streaming is best effort. Disable it and continue normal edit-stream flow.
      this.draftEnabled = false;
      logError("streaming", "draft_disabled_after_error", {
        error: errMsg,
        draftId: this.draftId,
      });
    }
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
        this.markInitialReplySent();
        return sent;
      }
      const sent = await this.withRetry(() => this.ctx.reply(safeText, replyOptions as any));
      this.markInitialReplySent();
      return sent;
    } catch {
      const sent = await this.withRetry(() => this.ctx.reply(safeText, replyOptions as any));
      this.markInitialReplySent();
      return sent;
    }
  }

  private markInitialReplySent(): void {
    this.initialReplySent = true;
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
    if (this.pendingDraftTimeout) {
      clearTimeout(this.pendingDraftTimeout);
      this.pendingDraftTimeout = null;
    }
  }

  /** Get accumulated text (for TTS or other post-processing) */
  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  /** Get the Telegram message id currently used for streaming output. */
  getCurrentMessageId(): number | null {
    return this.currentMessageId;
  }
}

export interface SendResponseOptions {
  text: string;
  includeAudio?: boolean;
  userId?: string;
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
  const { text, includeAudio = false, userId } = options;
  const allowlist = await loadAllowlist();
  const isAdmin = userId ? isAdminUser(userId, allowlist) : false;
  const msg = ctx.msg as { message_thread_id?: number } | undefined;
  const apiTagExecution = await executeTelegramApiTags(ctx.api, text, {
    callerType: "model_tag",
    userId,
    isAdmin,
    chatId: ctx.chat?.id,
    messageThreadId: typeof msg?.message_thread_id === "number" ? msg.message_thread_id : undefined,
  });
  const cleanedText = removeTelegramApiTags(apiTagExecution.cleanedText);
  if (apiTagExecution.summaryLines.length > 0) {
    info("response", "telegram_api_actions_executed", {
      count: apiTagExecution.summaryLines.length,
      summary: apiTagExecution.summaryLines.join(" | "),
    });
  }
  const hadApiErrors = hasTelegramApiErrors(apiTagExecution.summaryLines);
  const finalText = hadApiErrors
    ? appendTelegramApiFailureNote(cleanedText)
    : cleanedText;

  if (!finalText || finalText.trim().length === 0) {
    await ctx.reply("(empty response)", buildReplyOptions(ctx) as any);
    return;
  }

  // Voice response: send audio only (no text)
  // Requires: voice input flag, runtime TTS enabled, and TTS service available
  if (includeAudio && isTTSOutputEnabled() && (await isTTSAvailable())) {
    try {
      debug("response", "generating_audio", { userId, textLength: text.length });

      const audioResult = await generateAudio(finalText);

      if (!audioResult.success || !audioResult.audioPath) {
        debug("response", "audio_generation_failed", {
          userId,
          error: audioResult.error,
        });
        // Fall back to text if audio generation fails
        await ctx.reply(`[Voice unavailable] ${finalText}`, buildReplyOptions(ctx) as any);
        return;
      }

      // Verify file exists
      if (!fs.existsSync(audioResult.audioPath)) {
        logError("response", "audio_file_not_found", {
          userId,
          path: audioResult.audioPath,
        });
        await ctx.reply(`[Voice unavailable] ${finalText}`, buildReplyOptions(ctx) as any);
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
        await sendChatActionWithThreadContext(ctx, "upload_voice");
        await ctx.replyWithAudio(audioFile, buildReplyOptions(ctx) as any);
      } catch (audioErr: unknown) {
        if (audioErr instanceof Error && audioErr.message?.includes("VOICE_MESSAGES_FORBIDDEN")) {
          debug("response", "audio_blocked_trying_document", { userId });
          const docFile = new InputFile(audioResult.audioPath, "response.ogg");
          await sendChatActionWithThreadContext(ctx, "upload_document");
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
      await ctx.reply(`[Voice unavailable] ${finalText}`, buildReplyOptions(ctx) as any);
      return;
    }
  }

  // Check for file send requests in the response
  const fileSendRequests = parseFileSendRequest(finalText);
  let remainingText = fileSendRequests.length > 0 ? removeFileTags(finalText) : finalText;

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
        await sendChatActionWithThreadContext(ctx, "upload_photo");
        await ctx.replyWithPhoto(inputFile, {
          ...buildReplyOptions(ctx, { quote: false }),
          caption: fileRequest.caption,
        } as any);
      } else if (isVideoMimeType(mimeType)) {
        await sendChatActionWithThreadContext(ctx, "upload_video");
        await ctx.replyWithVideo(inputFile, {
          ...buildReplyOptions(ctx, { quote: false }),
          caption: fileRequest.caption,
        } as any);
      } else if (isAudioMimeType(mimeType)) {
        await sendChatActionWithThreadContext(ctx, "upload_voice");
        await ctx.replyWithAudio(inputFile, {
          ...buildReplyOptions(ctx, { quote: false }),
          caption: fileRequest.caption,
        } as any);
      } else {
        await sendChatActionWithThreadContext(ctx, "upload_document");
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
    try {
      await ctx.reply(toTelegramMarkdown(remainingText), {
        ...buildReplyOptions(ctx),
        parse_mode: "MarkdownV2",
      } as any);
    } catch {
      await ctx.reply(remainingText, buildReplyOptions(ctx) as any);
    }
  }
}

/**
 * Send error response
 */
export async function sendErrorResponse(ctx: Context, error: string, userId?: string): Promise<void> {
  const text = error || "An error occurred processing your request.";
  await sendResponse(ctx, { text, includeAudio: false, userId });
}

/**
 * Send typing indicator
 */
export async function sendTypingIndicator(ctx: Context): Promise<void> {
  try {
    await sendChatActionWithThreadContext(ctx, "typing");
  } catch {
    // Ignore failures
  }
}
