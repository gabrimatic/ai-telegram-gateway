import { GrammyError } from "grammy";
import { error as logError, info, warn } from "./logger";
import { isAdminUser, loadAllowlist } from "./storage";
import { registerTopic, removeTopic } from "./topic-registry";

export type TelegramApiCallerType = "command" | "model_tag" | "scheduler";

export interface TelegramApiTag {
  raw: string;
  method: string;
  payload: string;
  index: number;
}

export interface TelegramApiCallRequest {
  method: string;
  payload: Record<string, unknown>;
}

export interface TelegramApiExecutionMeta {
  callerType: TelegramApiCallerType;
  userId?: string;
  chatId?: string | number;
  messageThreadId?: number;
  isAdmin?: boolean;
  botId?: number;
}

export interface TelegramApiExecutionResult {
  success: boolean;
  method: string;
  payload: Record<string, unknown>;
  result?: unknown;
  summary: string;
  errorCode?: number;
  description?: string;
}

export interface ParsedJsonPayload {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
}

export interface TelegramApiContextLike {
  api?: {
    raw?: Record<string, (...args: any[]) => Promise<unknown>>;
    getMe?: () => Promise<{ id: number }>;
    getChat?: (chatId: number | string) => Promise<{ type: string; title?: string }>;
    getChatMember?: (chatId: number | string, userId: number) => Promise<unknown>;
  };
  raw?: Record<string, (...args: any[]) => Promise<unknown>>;
  getMe?: () => Promise<{ id: number }>;
  getChat?: (chatId: number | string) => Promise<{ type: string; title?: string }>;
  getChatMember?: (chatId: number | string, userId: number) => Promise<unknown>;
}

const TAG_LIMIT_PER_RESPONSE = 20;

/**
 * Quote-aware scanner that finds `<telegram-api ... />` tags even when
 * attribute values contain `>` (e.g. payload='{"name":"A > B"}').
 * Returns array of { raw, index } for each tag found.
 */
function scanTelegramApiTags(text: string): { raw: string; index: number }[] {
  const results: { raw: string; index: number }[] = [];
  const opener = "<telegram-api";
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const tagStart = text.toLowerCase().indexOf(opener, searchFrom);
    if (tagStart === -1) break;

    // Walk forward from after "<telegram-api", skipping quoted regions
    let i = tagStart + opener.length;
    let found = false;

    while (i < text.length) {
      const ch = text[i];

      // Enter quoted attribute value - skip to matching close quote
      if (ch === "'" || ch === '"') {
        const q = ch;
        i++;
        while (i < text.length && text[i] !== q) {
          // Only skip backslash+quote (the delimiter escape we support)
          if (text[i] === "\\" && i + 1 < text.length && text[i + 1] === q) {
            i += 2;
            continue;
          }
          i++;
        }
        if (i < text.length) i++; // skip closing quote
        continue;
      }

      // Self-closing end: />
      if (ch === "/" && i + 1 < text.length && text[i + 1] === ">") {
        const raw = text.slice(tagStart, i + 2);
        results.push({ raw, index: tagStart });
        searchFrom = i + 2;
        found = true;
        break;
      }

      // Bare > without preceding / means malformed tag - stop scanning this match
      if (ch === ">") {
        break;
      }

      i++;
    }

    if (!found) {
      searchFrom = tagStart + opener.length;
    }
  }

  return results;
}

const METHOD_RIGHTS: Record<string, string> = {
  createForumTopic: "can_manage_topics",
  editForumTopic: "can_manage_topics",
  closeForumTopic: "can_manage_topics",
  reopenForumTopic: "can_manage_topics",
  deleteForumTopic: "can_delete_messages",
  unpinAllForumTopicMessages: "can_pin_messages",
  editGeneralForumTopic: "can_manage_topics",
  closeGeneralForumTopic: "can_manage_topics",
  reopenGeneralForumTopic: "can_manage_topics",
  hideGeneralForumTopic: "can_manage_topics",
  unhideGeneralForumTopic: "can_manage_topics",
  setChatTitle: "can_change_info",
  setChatDescription: "can_change_info",
  setChatPermissions: "can_restrict_members",
};

const CREATOR_EXCEPTION_METHODS = new Set([
  "editForumTopic",
  "closeForumTopic",
  "reopenForumTopic",
]);

const THREAD_CONTEXT_METHODS = new Set([
  "editForumTopic",
  "closeForumTopic",
  "reopenForumTopic",
  "deleteForumTopic",
  "unpinAllForumTopicMessages",
]);

function getApiClient(ctxOrBotApi: TelegramApiContextLike): Required<TelegramApiContextLike> {
  const api = ctxOrBotApi.api ?? ctxOrBotApi;
  if (!api.raw || typeof api.raw !== "object") {
    throw new Error("Telegram API client does not expose api.raw");
  }
  return api as Required<TelegramApiContextLike>;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function resolveMethodName(method: string, ctxOrBotApi: TelegramApiContextLike): string {
  try {
    const api = ctxOrBotApi.api ?? ctxOrBotApi;
    const raw = api.raw as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return method;
    if (method in raw) return method;
    const lower = method.toLowerCase();
    const found = Object.keys(raw).find(k => k.toLowerCase() === lower);
    return found ?? method;
  } catch {
    return method;
  }
}

function getChatIdFromPayload(payload: Record<string, unknown>, fallback?: string | number): string | number | undefined {
  const candidate = payload.chat_id;
  if (typeof candidate === "number" || typeof candidate === "string") {
    return candidate;
  }
  return fallback;
}

async function resolveBotId(api: Required<TelegramApiContextLike>, meta: TelegramApiExecutionMeta): Promise<number> {
  if (typeof meta.botId === "number" && Number.isFinite(meta.botId)) {
    return meta.botId;
  }
  if (typeof api.getMe !== "function") {
    throw new Error("Bot identity unavailable (getMe missing)");
  }
  const me = await api.getMe();
  if (!me?.id) {
    throw new Error("Failed to resolve bot identity");
  }
  return me.id;
}

function parseTelegramError(err: unknown): { code?: number; description: string } {
  if (err instanceof GrammyError) {
    return {
      code: err.error_code,
      description: err.description || err.message,
    };
  }
  if (err instanceof Error) {
    return { description: err.message };
  }
  return { description: String(err) };
}

function compactValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "null";
  const text = JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

async function resolveTopicIconEmoji(
  api: Required<TelegramApiContextLike>,
  method: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (method !== "createForumTopic" && method !== "editForumTopic") {
    return;
  }
  if (payload.icon_custom_emoji_id) {
    return;
  }

  const iconEmoji = typeof payload.icon_emoji === "string"
    ? payload.icon_emoji.trim()
    : "";
  if (!iconEmoji) {
    return;
  }

  const iconFetcher = (api.raw as Record<string, unknown>).getForumTopicIconStickers;
  if (typeof iconFetcher !== "function") {
    throw new Error("getForumTopicIconStickers is unavailable");
  }

  const stickersRaw = await (iconFetcher as () => Promise<unknown>)();
  if (!Array.isArray(stickersRaw)) {
    throw new Error("Failed to resolve topic icon: unexpected sticker list format");
  }

  const stickers = stickersRaw as Array<Record<string, unknown>>;
  const match = stickers.find((sticker) => sticker?.emoji === iconEmoji);
  if (!match || typeof match.custom_emoji_id !== "string" || !match.custom_emoji_id.trim()) {
    const available = stickers
      .map((sticker) => typeof sticker?.emoji === "string" ? sticker.emoji : "")
      .filter(Boolean)
      .slice(0, 12);
    const hint = available.length > 0
      ? ` Available topic emojis: ${available.join(" ")}`
      : "";
    throw new Error(`No custom icon found for emoji '${iconEmoji}'.${hint} Use /topic icons to list all available topic emojis.`);
  }

  payload.icon_custom_emoji_id = match.custom_emoji_id;
  delete payload.icon_emoji;
}

function summarizeResult(method: string, result: unknown): string {
  if (typeof result === "boolean") {
    return `${method} returned ${result ? "ok" : "false"}`;
  }

  if (!result || typeof result !== "object") {
    return `${method} returned ${compactValue(result)}`;
  }

  const record = result as Record<string, unknown>;
  const interestingKeys = [
    "message_thread_id",
    "forum_topic_created",
    "title",
    "id",
    "status",
    "type",
  ];

  const snippets = interestingKeys
    .filter((key) => key in record)
    .map((key) => `${key}=${compactValue(record[key])}`)
    .slice(0, 4);

  if (snippets.length > 0) {
    return `${method} ok (${snippets.join(", ")})`;
  }

  const preview = compactValue(record);
  return `${method} ok (${preview})`;
}

async function assertBotRightsForMethod(
  api: Required<TelegramApiContextLike>,
  method: string,
  payload: Record<string, unknown>,
  meta: TelegramApiExecutionMeta
): Promise<void> {
  const requiredRight = METHOD_RIGHTS[method];
  if (!requiredRight) return;

  const chatId = getChatIdFromPayload(payload, meta.chatId);
  if (chatId === undefined || chatId === null || `${chatId}`.trim().length === 0) {
    throw new Error(`Missing chat_id for ${method}`);
  }

  if (typeof api.getChat !== "function" || typeof api.getChatMember !== "function") {
    throw new Error(`Cannot validate bot rights for ${method} (chat API unavailable)`);
  }

  const chat = await api.getChat(chatId);
  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  const botId = await resolveBotId(api, meta);
  const member = toRecord(await api.getChatMember(chatId, botId));
  const status = typeof member.status === "string" ? member.status : "unknown";
  if (status !== "administrator" && status !== "creator") {
    throw new Error(`Bot must be administrator in this chat to call ${method}`);
  }

  if (status === "creator") {
    return;
  }

  const hasRight = member[requiredRight] === true;
  if (!hasRight) {
    // Telegram allows topic creators to manage their own topics
    // even without can_manage_topics - let API be source of truth
    if (CREATOR_EXCEPTION_METHODS.has(method)) {
      return;
    }
    throw new Error(`Missing bot admin right '${requiredRight}' for ${method}`);
  }
}

export function parseTelegramApiPayload(payloadText: string): ParsedJsonPayload {
  const trimmed = payloadText.trim();
  if (!trimmed) {
    return { ok: false, error: "Payload JSON is empty" };
  }

  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Payload must be a JSON object" };
    }
    return { ok: true, payload: value as Record<string, unknown> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const posMatch = message.match(/position\s+(\d+)/i);
    if (posMatch) {
      return { ok: false, error: `Invalid JSON payload near character ${posMatch[1]}: ${message}` };
    }
    return { ok: false, error: `Invalid JSON payload: ${message}` };
  }
}

function extractPayloadAttribute(raw: string): string | null {
  const payloadIdx = raw.search(/payload\s*=\s*['"]/i);
  if (payloadIdx === -1) return null;
  const eqIdx = raw.indexOf("=", payloadIdx);
  if (eqIdx === -1) return null;
  let start = eqIdx + 1;
  while (start < raw.length && raw[start] === " ") start++;
  const quote = raw[start];
  if (quote !== "'" && quote !== '"') return null;
  start++;
  let result = "";
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    // Only treat backslash as escape for the delimiter quote itself
    if (ch === "\\" && i + 1 < raw.length && raw[i + 1] === quote) {
      result += quote;
      i++;
      continue;
    }
    if (ch === quote) return result;
    result += ch;
  }
  return null; // unterminated
}

export function parseTelegramApiTags(text: string): TelegramApiTag[] {
  const tags: TelegramApiTag[] = [];
  if (!text) return tags;

  const scanned = scanTelegramApiTags(text);
  for (const { raw, index } of scanned) {
    const methodMatch = raw.match(/method\s*=\s*["']([^"']+)["']/i);
    const payloadValue = extractPayloadAttribute(raw);

    if (!methodMatch || payloadValue === null) {
      continue;
    }

    tags.push({
      raw,
      method: methodMatch[1].trim(),
      payload: payloadValue,
      index,
    });
  }

  return tags;
}

export function removeTelegramApiTags(text: string): string {
  if (!text) return text;
  const scanned = scanTelegramApiTags(text);
  let result = text;

  if (scanned.length > 0) {
    // Remove tags in reverse order to preserve indices.
    for (let i = scanned.length - 1; i >= 0; i--) {
      const { raw, index } = scanned[i];
      result = result.slice(0, index) + result.slice(index + raw.length);
    }
  }

  // Fallback scrub for malformed/unclosed telegram-api tags so raw control markup
  // never leaks to users.
  result = result.replace(/<telegram-api\b[^>]*>/gi, "");
  return result.trim();
}

export async function isAdminActor(userId?: string, provided?: boolean): Promise<boolean> {
  if (provided !== undefined) {
    return provided;
  }
  if (!userId) return false;
  const allowlist = await loadAllowlist();
  return isAdminUser(userId, allowlist);
}

export async function executeTelegramApiCall(
  ctxOrBotApi: TelegramApiContextLike,
  request: TelegramApiCallRequest,
  meta: TelegramApiExecutionMeta
): Promise<TelegramApiExecutionResult> {
  const api = getApiClient(ctxOrBotApi);
  const method = request.method.trim();
  const payload = request.payload || {};

  // Resolve case-insensitive method name early so rights checks and
  // downstream logic all use the canonical Telegram method key.
  const rawKeys = Object.keys(api.raw as Record<string, unknown>);
  let resolvedMethodKey = method;
  if (!(method in (api.raw as Record<string, unknown>))) {
    const lowerMethod = method.toLowerCase();
    const found = rawKeys.find(k => k.toLowerCase() === lowerMethod);
    if (found) resolvedMethodKey = found;
  }

  const chatId = getChatIdFromPayload(payload, meta.chatId);

  const admin = await isAdminActor(meta.userId, meta.isAdmin);
  if (!admin) {
    const result: TelegramApiExecutionResult = {
      success: false,
      method: resolvedMethodKey,
      payload,
      summary: `Blocked ${resolvedMethodKey}: admin only`,
      description: "admin only",
    };
    warn("telegram-api", "telegram_api_call_failed", {
      callerType: meta.callerType,
      method: resolvedMethodKey,
      chatId,
      userId: meta.userId,
      success: false,
      description: result.description,
    });
    return result;
  }

  const rawMethod = (api.raw as Record<string, unknown>)[resolvedMethodKey];
  if (typeof rawMethod !== "function") {
    const unknownResult: TelegramApiExecutionResult = {
      success: false,
      method,
      payload,
      summary: `Unknown Telegram method: ${method}`,
      description: "unknown_method",
    };
    warn("telegram-api", "telegram_api_call_failed", {
      callerType: meta.callerType,
      method,
      chatId,
      userId: meta.userId,
      success: false,
      description: unknownResult.description,
    });
    return unknownResult;
  }

  try {
    await resolveTopicIconEmoji(api, resolvedMethodKey, payload);
    const normalizedThreadId = toPositiveInteger(payload.message_thread_id);
    if (normalizedThreadId !== null) {
      payload.message_thread_id = normalizedThreadId;
    }
    await assertBotRightsForMethod(api, resolvedMethodKey, payload, meta);
    const payloadKeys = Object.keys(payload);
    const result = payloadKeys.length > 0
      ? await (rawMethod as (data: Record<string, unknown>) => Promise<unknown>)(payload)
      : await (rawMethod as () => Promise<unknown>)();
    const summary = summarizeResult(resolvedMethodKey, result);

    // Update topic registry on create/delete
    if (resolvedMethodKey === "createForumTopic" && result && typeof result === "object") {
      const topicResult = result as Record<string, unknown>;
      const topicChatId = getChatIdFromPayload(payload, meta.chatId);
      const threadId = typeof topicResult.message_thread_id === "number" ? topicResult.message_thread_id : null;
      const topicName = typeof payload.name === "string" ? payload.name : "";
      const topicIcon = typeof payload.icon_emoji === "string" ? payload.icon_emoji : undefined;
      if (topicChatId && threadId && topicName) {
        registerTopic(Number(topicChatId), threadId, topicName, topicIcon);
      }
    }
    if (resolvedMethodKey === "deleteForumTopic") {
      const topicChatId = getChatIdFromPayload(payload, meta.chatId);
      const threadId = typeof payload.message_thread_id === "number" ? payload.message_thread_id : null;
      if (topicChatId && threadId) {
        removeTopic(Number(topicChatId), threadId);
      }
    }

    info("telegram-api", "telegram_api_call", {
      callerType: meta.callerType,
      method: resolvedMethodKey,
      chatId,
      userId: meta.userId,
      success: true,
    });

    return {
      success: true,
      method: resolvedMethodKey,
      payload,
      result,
      summary,
    };
  } catch (err) {
    const parsed = parseTelegramError(err);

    // Retry topic-thread operations once with current thread context if Telegram
    // reports an invalid topic identifier and we have a valid runtime thread id.
    const runtimeThreadId = toPositiveInteger(meta.messageThreadId);
    const payloadThreadId = toPositiveInteger(payload.message_thread_id);
    const descriptionText = typeof parsed.description === "string"
      ? parsed.description
      : "";
    const has400Status = parsed.code === 400 || /^\s*400\b/i.test(descriptionText);
    const shouldRetryWithContextThread = has400Status
      && descriptionText.toLowerCase().includes("invalid forum topic identifier")
      && THREAD_CONTEXT_METHODS.has(resolvedMethodKey)
      && runtimeThreadId !== null
      && payloadThreadId !== runtimeThreadId;

    if (shouldRetryWithContextThread) {
      try {
        const retryPayload = {
          ...payload,
          message_thread_id: runtimeThreadId,
        };
        const retryResult = await (rawMethod as (data: Record<string, unknown>) => Promise<unknown>)(retryPayload);
        const retrySummary = summarizeResult(resolvedMethodKey, retryResult);
        info("telegram-api", "telegram_api_call_retry_with_context_thread", {
          callerType: meta.callerType,
          method: resolvedMethodKey,
          chatId,
          userId: meta.userId,
          contextThreadId: runtimeThreadId,
          originalThreadId: payloadThreadId,
          success: true,
        });
        return {
          success: true,
          method: resolvedMethodKey,
          payload: retryPayload,
          result: retryResult,
          summary: `${retrySummary} (retried with current thread context)`,
        };
      } catch {
        // Fall through to the original error response.
      }
    }

    const failure: TelegramApiExecutionResult = {
      success: false,
      method: resolvedMethodKey,
      payload,
      summary: `${resolvedMethodKey} failed: ${parsed.description}`,
      errorCode: parsed.code,
      description: parsed.description,
    };

    logError("telegram-api", "telegram_api_call_failed", {
      callerType: meta.callerType,
      method: resolvedMethodKey,
      chatId,
      userId: meta.userId,
      success: false,
      errorCode: parsed.code,
      description: parsed.description,
    });

    return failure;
  }
}

export async function executeTelegramApiTags(
  ctxOrBotApi: TelegramApiContextLike,
  text: string,
  meta: TelegramApiExecutionMeta
): Promise<{ cleanedText: string; summaryLines: string[]; hadTags: boolean }> {
  const tags = parseTelegramApiTags(text);
  if (tags.length === 0) {
    return {
      cleanedText: text,
      summaryLines: [],
      hadTags: false,
    };
  }

  const admin = await isAdminActor(meta.userId, meta.isAdmin);
  const cleanedText = removeTelegramApiTags(text);

  if (!admin) {
    return {
      cleanedText,
      summaryLines: ["Ignored 1+ Telegram API action(s): admin only."],
      hadTags: true,
    };
  }

  const summaryLines: string[] = [];
  const limitedTags = tags.slice(0, TAG_LIMIT_PER_RESPONSE);
  for (let i = 0; i < limitedTags.length; i++) {
    const tag = limitedTags[i];
    const parsed = parseTelegramApiPayload(tag.payload);
    if (!parsed.ok || !parsed.payload) {
      summaryLines.push(`#${i + 1} ${tag.method}: ERROR ${parsed.error}`);
      continue;
    }

    // Resolve case-insensitive method name for context auto-fill checks
    const resolvedMethod = resolveMethodName(tag.method, ctxOrBotApi);

    // Auto-fill context from meta when model omits it
    if (!parsed.payload.chat_id && meta.chatId !== undefined) {
      parsed.payload.chat_id = meta.chatId;
    }
    if (THREAD_CONTEXT_METHODS.has(resolvedMethod)
      && !parsed.payload.message_thread_id
      && meta.messageThreadId !== undefined) {
      parsed.payload.message_thread_id = meta.messageThreadId;
    }

    const result = await executeTelegramApiCall(ctxOrBotApi, {
      method: resolvedMethod,
      payload: parsed.payload,
    }, meta);

    if (result.success) {
      summaryLines.push(`#${i + 1} ${tag.method}: OK`);
    } else {
      const details = result.errorCode
        ? `${result.errorCode} ${result.description ?? ""}`.trim()
        : result.description ?? "failed";
      summaryLines.push(`#${i + 1} ${tag.method}: ERROR ${details}`);
    }
  }

  if (tags.length > TAG_LIMIT_PER_RESPONSE) {
    summaryLines.push(`Ignored ${tags.length - TAG_LIMIT_PER_RESPONSE} extra tag(s); max ${TAG_LIMIT_PER_RESPONSE} per response.`);
  }

  return {
    cleanedText,
    summaryLines,
    hadTags: true,
  };
}
