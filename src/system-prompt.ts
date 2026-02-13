import { FILE_PROTOCOL, buildSendFileTag } from "./file-protocol";
import { env } from "./env";

export interface SessionContext {
  messageCount: number;
  recentFailures: number;
  isVoiceInput?: boolean;
  hasFileAttachment?: boolean;
  isTTSEnabled?: boolean;
}

export interface SystemPromptOptions {
  providerDisplayName?: string;
}

/**
 * Static system prompt set once at CLI session spawn via --system-prompt.
 * Contains identity, rules, and protocol definitions that don't change per-message.
 * Kept compact to minimize token overhead (~800 tokens).
 */
export function buildStaticSystemPrompt(options: SystemPromptOptions = {}): string {
  const providerDisplayName = options.providerDisplayName?.trim();
  const assistantName = providerDisplayName || "AI assistant";
  const adminName = env.TG_ADMIN_NAME.trim();
  const botUsername = env.TG_BOT_USERNAME.trim();
  const hostLabel = env.TG_HOST_LABEL.trim() || "local host";
  const projectPathHint = env.TG_PROJECT_PATH_HINT.trim();

  const lines: string[] = [
    `You are ${assistantName}, a Telegram bot on ${hostLabel} (macOS, PM2 process "telegram-gateway").`,
    adminName ? `Admin: ${adminName}.` : "",
    botUsername ? `Bot: @${botUsername}.` : "",
    projectPathHint ? `Project: ${projectPathHint}.` : "",
    "",
    "RULES:",
    "- Never restart gateway directly; use /deploy for safe restart + rollback.",
    "- Run shell commands/tools only when useful for the request.",
    "- For Telegram actions, emit self-closing tags: <telegram-api method=\"METHOD\" payload='{...}' />",
    "  chat_id and message_thread_id auto-fill from conversation context. Methods are case-insensitive. Max 20 tags. Admin-only.",
    "  For topic icons, you may pass icon_emoji (e.g. 📬); gateway resolves it to icon_custom_emoji_id when available.",
    "- Do not claim memory across sessions beyond context provided.",
    "- Correctness over speed. Facts vs assumptions. Answer first, details after.",
    "",
    "PROTOCOLS:",
    `- Send files: ${buildSendFileTag("/path/to/file", "caption")}`,
    "- [SENTINEL] prompts: execute checklist, respond SENTINEL_OK if healthy.",
    "",
    "FORMATTING:",
    "- Telegram max 4096 chars. Offer file for long content.",
    "- Standard Markdown auto-converts. Keep formatting minimal in casual chat.",
    "",
    "PERSONALITY:",
    "- Super chatty, friendly, casual, and cool. Talk like a close friend texting.",
    "- Use natural conversational energy - be warm, enthusiastic, and real.",
    "- Match the user's vibe. Crack jokes, use slang, be playful.",
    "- Still helpful and accurate - just never stiff or robotic.",
  ];

  return lines.filter(Boolean).join("\n");
}

/**
 * Per-message dynamic context prepended to user messages.
 * Only includes info that changes between messages (voice, file, TTS, session stats).
 */
export function buildDynamicContext(
  context: SessionContext,
  memoryContext?: string
): string {
  const parts: string[] = [];

  if (context.isTTSEnabled) {
    parts.push("VOICE MODE: 15 WORDS MAX. Write for speech, match tone to content.\n");
  }

  if (context.isVoiceInput) {
    parts.push("[Voice message transcribed via WhisperKit]");
  }

  if (context.hasFileAttachment) {
    parts.push(
      `[File attached - use Read tool on the local_path in the ${FILE_PROTOCOL.attachedFileOpen} block below]`
    );
  }

  const meta: string[] = [];
  if (context.messageCount > 0) meta.push(`msg #${context.messageCount + 1}`);
  if (context.recentFailures > 0) meta.push(`${context.recentFailures} recent failures`);
  if (memoryContext?.trim()) meta.push(`memory: ${memoryContext.trim()}`);
  if (meta.length > 0) parts.push(`[${meta.join(" | ")}]`);

  return parts.length > 0 ? parts.join("\n") + "\n\n" : "";
}

/**
 * Build the full per-message system prompt (legacy path, used by forwardToClaude helpers).
 * When --system-prompt is active on the CLI, this returns only dynamic context.
 */
export function buildSystemPrompt(
  context: SessionContext,
  memoryContext?: string,
  options: SystemPromptOptions = {}
): string {
  return buildDynamicContext(context, memoryContext);
}

export function wrapWithSystemPrompt(
  systemPrompt: string,
  userMessage: string
): string {
  // When using --system-prompt, the "system prompt" here is just dynamic context.
  // No XML wrapping needed - prepend directly to user message.
  if (!systemPrompt.trim()) return userMessage;
  return `${systemPrompt}${userMessage}`;
}
