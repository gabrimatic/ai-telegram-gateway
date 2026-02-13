import { GrammyError } from "grammy";
import { error as logError, info, warn } from "./logger";
import { isAdminUser, loadAllowlist } from "./storage";

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

const TELEGRAM_API_TAG_RE = /<telegram-api\b[^>]*\/>/gi;
const TAG_LIMIT_PER_RESPONSE = 5;

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

export function parseTelegramApiTags(text: string): TelegramApiTag[] {
  const tags: TelegramApiTag[] = [];
  if (!text) return tags;

  let match: RegExpExecArray | null;
  while ((match = TELEGRAM_API_TAG_RE.exec(text)) !== null) {
    const raw = match[0];
    const methodMatch = raw.match(/method\s*=\s*"([^"]+)"/i);
    const payloadMatch = raw.match(/payload\s*=\s*'([^']*)'/i)
      || raw.match(/payload\s*=\s*"([^"]*)"/i);

    if (!methodMatch || !payloadMatch) {
      continue;
    }

    tags.push({
      raw,
      method: methodMatch[1].trim(),
      payload: payloadMatch[1],
      index: match.index,
    });
  }

  return tags;
}

export function removeTelegramApiTags(text: string): string {
  if (!text) return text;
  return text.replace(TELEGRAM_API_TAG_RE, "").trim();
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
  const chatId = getChatIdFromPayload(payload, meta.chatId);

  const admin = await isAdminActor(meta.userId, meta.isAdmin);
  if (!admin) {
    const result: TelegramApiExecutionResult = {
      success: false,
      method,
      payload,
      summary: `Blocked ${method}: admin only`,
      description: "admin only",
    };
    warn("telegram-api", "telegram_api_call_failed", {
      callerType: meta.callerType,
      method,
      chatId,
      userId: meta.userId,
      success: false,
      description: result.description,
    });
    return result;
  }

  const rawMethod = (api.raw as Record<string, unknown>)[method];
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
    await assertBotRightsForMethod(api, method, payload, meta);
    const payloadKeys = Object.keys(payload);
    const result = payloadKeys.length > 0
      ? await (rawMethod as (data: Record<string, unknown>) => Promise<unknown>)(payload)
      : await (rawMethod as () => Promise<unknown>)();
    const summary = summarizeResult(method, result);

    info("telegram-api", "telegram_api_call", {
      callerType: meta.callerType,
      method,
      chatId,
      userId: meta.userId,
      success: true,
    });

    return {
      success: true,
      method,
      payload,
      result,
      summary,
    };
  } catch (err) {
    const parsed = parseTelegramError(err);
    const failure: TelegramApiExecutionResult = {
      success: false,
      method,
      payload,
      summary: `${method} failed: ${parsed.description}`,
      errorCode: parsed.code,
      description: parsed.description,
    };

    logError("telegram-api", "telegram_api_call_failed", {
      callerType: meta.callerType,
      method,
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

    const result = await executeTelegramApiCall(ctxOrBotApi, {
      method: tag.method,
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
