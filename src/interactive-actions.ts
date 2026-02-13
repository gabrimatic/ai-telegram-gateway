import { InlineKeyboard } from "grammy";

export type ActionName = "regen" | "short" | "deep";

export interface ActionContext {
  userId: string;
  prompt: string;
  responseContext?: string;
  availableActions?: ActionName[];
  createdAt: number;
}

const ACTION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_ACTION_CONTEXTS = 300;
const contexts = new Map<string, ActionContext>();
const latestTokenByUser = new Map<string, string>();

function removeContextToken(token: string): void {
  const existing = contexts.get(token);
  contexts.delete(token);
  if (!existing) return;
  if (latestTokenByUser.get(existing.userId) === token) {
    latestTokenByUser.delete(existing.userId);
  }
}

function randomToken(length: number = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < length; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

function cleanupExpiredContexts(now: number = Date.now()): void {
  for (const [token, ctx] of contexts.entries()) {
    if (now - ctx.createdAt > ACTION_TTL_MS) {
      removeContextToken(token);
    }
  }
}

function trimToLimit(): void {
  if (contexts.size <= MAX_ACTION_CONTEXTS) return;
  const entries = [...contexts.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  const excess = contexts.size - MAX_ACTION_CONTEXTS;
  for (let i = 0; i < excess; i++) {
    removeContextToken(entries[i][0]);
  }
}

export function createActionContext(userId: string, prompt: string, responseContext?: string): string {
  cleanupExpiredContexts();

  let token = randomToken();
  while (contexts.has(token)) {
    token = randomToken();
  }

  contexts.set(token, {
    userId,
    prompt,
    responseContext,
    createdAt: Date.now(),
  });
  latestTokenByUser.set(userId, token);
  trimToLimit();

  return token;
}

export function getActionContext(token: string): ActionContext | undefined {
  const ctx = contexts.get(token);
  if (!ctx) return undefined;
  if (Date.now() - ctx.createdAt > ACTION_TTL_MS) {
    removeContextToken(token);
    return undefined;
  }
  return ctx;
}

export function getLatestActionContextForUser(userId: string): ActionContext | undefined {
  const token = latestTokenByUser.get(userId);
  if (!token) return undefined;
  const ctx = getActionContext(token);
  if (!ctx) {
    latestTokenByUser.delete(userId);
    return undefined;
  }
  return ctx;
}

export function setActionContextAvailableActions(token: string, actions: ActionName[]): void {
  const ctx = getActionContext(token);
  if (!ctx) return;
  ctx.availableActions = [...actions];
}

export function buildActionPrompt(action: ActionName, basePrompt: string): string {
  switch (action) {
    case "short":
      return [
        "Re-answer this request in a shorter format.",
        "- Max 120 words",
        "- Prioritize the most useful result",
        "",
        "Request:",
        basePrompt,
      ].join("\n");
    case "deep":
      return [
        "Re-answer this request with deeper practical detail.",
        "- Include concrete steps",
        "- Include risks and edge cases where relevant",
        "- Keep it focused and actionable",
        "",
        "Request:",
        basePrompt,
      ].join("\n");
    case "regen":
    default:
      return basePrompt;
  }
}

export function buildActionKeyboard(
  token: string,
  options?: { actions?: ActionName[]; includeContext?: boolean }
): InlineKeyboard {
  const actions = options?.actions ?? ["regen", "short", "deep"];
  const includeContext = options?.includeContext ?? true;
  const keyboard = new InlineKeyboard();
  const hasAction = (name: ActionName): boolean => actions.includes(name);

  if (hasAction("regen")) {
    keyboard.text("\u{1F501} Again", `ai_regen_${token}`);
  }
  if (hasAction("short")) {
    keyboard.text("\u2702\uFE0F Shorter", `ai_short_${token}`);
  }
  if (hasAction("deep")) {
    keyboard.text("\u{1F9E0} Deeper", `ai_deep_${token}`);
  }
  if (includeContext) {
    keyboard.text("\u2139\uFE0F Context", `ai_ctx_${token}`);
  }
  return keyboard;
}
