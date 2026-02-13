import { Context } from "grammy";

const MAIN_THREAD = "main";
const UNKNOWN_CHAT = "unknown";

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function sanitizeReplyText(value: string): string {
  return value
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function truncateReplyText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}

function resolveReplyAuthor(replyFrom: any): string {
  if (!replyFrom || typeof replyFrom !== "object") {
    return "Unknown";
  }

  const firstName = typeof replyFrom.first_name === "string" ? replyFrom.first_name.trim() : "";
  const lastName = typeof replyFrom.last_name === "string" ? replyFrom.last_name.trim() : "";
  const username = typeof replyFrom.username === "string" ? replyFrom.username.trim() : "";

  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  if (username) return `@${username}`;
  return "Unknown";
}

export function buildConversationKey(chatId: string | number | bigint, messageThreadId?: number | null): string {
  const chatPart = String(chatId);
  const threadPart = typeof messageThreadId === "number" && messageThreadId > 0
    ? String(messageThreadId)
    : MAIN_THREAD;
  return `chat:${chatPart}:thread:${threadPart}`;
}

export function getConversationKeyFromContext(ctx: Context): string {
  const anyCtx = ctx as any;
  const chatId = ctx.chat?.id
    ?? anyCtx?.message?.chat?.id
    ?? anyCtx?.callbackQuery?.message?.chat?.id;
  const messageThreadId = anyCtx?.message?.message_thread_id
    ?? anyCtx?.callbackQuery?.message?.message_thread_id;

  if (!hasValue(chatId)) {
    return `chat:${UNKNOWN_CHAT}:thread:${MAIN_THREAD}`;
  }

  return buildConversationKey(chatId as string | number | bigint, messageThreadId as number | undefined);
}

export function buildReplyContextEnvelope(
  ctx: Context,
  currentMessageText: string,
  maxReplyChars: number
): string {
  const anyCtx = ctx as any;
  const reply = anyCtx?.message?.reply_to_message;

  if (!reply || typeof reply !== "object") {
    return currentMessageText;
  }

  const sourceText = typeof reply.text === "string"
    ? reply.text
    : (typeof reply.caption === "string" ? reply.caption : "");

  if (!sourceText.trim()) {
    return currentMessageText;
  }

  const safeSnippet = truncateReplyText(sanitizeReplyText(sourceText), maxReplyChars);
  if (!safeSnippet) {
    return currentMessageText;
  }

  const author = resolveReplyAuthor(reply.from);

  return [
    "Reply context:",
    `Author: ${author}`,
    `Replied message: ${safeSnippet}`,
    "",
    "Current message:",
    currentMessageText,
  ].join("\n");
}
