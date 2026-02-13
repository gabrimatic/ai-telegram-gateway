/**
 * Claude integration helpers for the Telegram Gateway bot
 */

import { Context, InlineKeyboard } from "grammy";
import { runAI, getStats as getAIStats } from "./ai";
import { getConfig } from "./config";
import { error } from "./logger";
import { incrementMessages, incrementErrors } from "./health";
import { recordSuccess, recordFailure } from "./metrics";
import { buildSystemPrompt, wrapWithSystemPrompt, SessionContext } from "./system-prompt";
import { loadMemoryContext } from "./memory";

// Forward a prompt to Claude and reply with the response
export async function forwardToClaude(ctx: Context, prompt: string): Promise<boolean> {
  try {
    const config = getConfig();
    let finalPrompt = prompt;

    if (config.enableSystemPrompt) {
      const stats = getAIStats();
      const context: SessionContext = {
        messageCount: stats?.messageCount ?? 0,
        recentFailures: stats?.recentFailures ?? 0,
      };
      const memoryContext = loadMemoryContext();
      const systemPrompt = buildSystemPrompt(context, memoryContext, {
        providerDisplayName: config.providerDisplayName,
      });
      finalPrompt = wrapWithSystemPrompt(systemPrompt, prompt);
    }

    const result = await runAI(finalPrompt);
    incrementMessages();

    if (result.success && result.response.trim()) {
      recordSuccess();
      await ctx.reply(result.response.trim());
    } else {
      recordFailure("unknown");
      await ctx.reply("Sorry, I couldn't get a response.");
    }
    return true;
  } catch (err) {
    incrementErrors();
    error("claude-helpers", "claude_forward_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.reply("An error occurred.");
    return true;
  }
}

// Forward a prompt to Claude and reply with the response and inline keyboard
export async function forwardToClaudeWithKeyboard(ctx: Context, prompt: string, keyboard: InlineKeyboard): Promise<boolean> {
  try {
    const config = getConfig();
    let finalPrompt = prompt;

    if (config.enableSystemPrompt) {
      const stats = getAIStats();
      const context: SessionContext = {
        messageCount: stats?.messageCount ?? 0,
        recentFailures: stats?.recentFailures ?? 0,
      };
      const memoryContext = loadMemoryContext();
      const systemPrompt = buildSystemPrompt(context, memoryContext, {
        providerDisplayName: config.providerDisplayName,
      });
      finalPrompt = wrapWithSystemPrompt(systemPrompt, prompt);
    }

    const result = await runAI(finalPrompt);
    incrementMessages();

    if (result.success && result.response.trim()) {
      recordSuccess();
      await ctx.reply(result.response.trim(), { reply_markup: keyboard });
    } else {
      recordFailure("unknown");
      await ctx.reply("Sorry, I couldn't get a response.");
    }
    return true;
  } catch (err) {
    incrementErrors();
    error("claude-helpers", "claude_forward_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.reply("An error occurred.");
    return true;
  }
}
