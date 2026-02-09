import { getConfig } from "./config";
import { FailureCategory } from "./failure-classifier";

export interface RetryDecision {
  shouldRetry: boolean;
  modifiedPrompt?: string;
  delayMs: number;
  fallbackMessage?: string;
  shouldRestartSession: boolean;
}

const FALLBACK_MESSAGES: Record<FailureCategory, string> = {
  timeout: "Sorry, that request took too long. Please try again or simplify your request.",
  process_crash: "I encountered an error and had to restart. Please try again.",
  confusion: "I'm having trouble understanding that request. Could you rephrase it?",
  mcp_tool_failure: "I couldn't complete that action because an external tool failed. Please try again later.",
  invalid_response: "I had trouble generating a proper response. Please try again.",
  unknown: "Something went wrong. Please try again.",
};

export function getRetryStrategy(
  category: FailureCategory,
  attempt: number,
  originalPrompt: string
): RetryDecision {
  const config = getConfig();
  const maxRetries = config.maxRetries;
  const baseDelay = config.retryBaseDelayMs;

  // Calculate exponential backoff delay
  const delayMs = baseDelay * Math.pow(2, attempt - 1);

  // If we've exceeded max retries, give up
  if (attempt >= maxRetries) {
    return {
      shouldRetry: false,
      delayMs: 0,
      fallbackMessage: FALLBACK_MESSAGES[category],
      shouldRestartSession: false,
    };
  }

  switch (category) {
    case 'timeout':
      // Retry immediately up to 2 times
      return {
        shouldRetry: attempt < 2,
        delayMs: 0,
        fallbackMessage: attempt >= 2 ? FALLBACK_MESSAGES.timeout : undefined,
        shouldRestartSession: false,
      };

    case 'process_crash':
      // Restart session and retry once
      return {
        shouldRetry: attempt < 1,
        delayMs: 500,
        fallbackMessage: attempt >= 1 ? FALLBACK_MESSAGES.process_crash : undefined,
        shouldRestartSession: true,
      };

    case 'confusion':
      // Retry with modified prompt
      return {
        shouldRetry: attempt < 2,
        modifiedPrompt: `Please provide a direct answer to the following question. Be concise and clear:\n\n${originalPrompt}`,
        delayMs: 0,
        fallbackMessage: attempt >= 2 ? FALLBACK_MESSAGES.confusion : undefined,
        shouldRestartSession: false,
      };

    case 'mcp_tool_failure':
      // Retry once, then fallback
      return {
        shouldRetry: attempt < 1,
        delayMs: 1000,
        fallbackMessage: attempt >= 1 ? FALLBACK_MESSAGES.mcp_tool_failure : undefined,
        shouldRestartSession: false,
      };

    case 'invalid_response':
      // Retry with hint to complete the response
      return {
        shouldRetry: attempt < 2,
        modifiedPrompt: `Please give a complete response to: ${originalPrompt}\n\nMake sure to finish your thoughts and end properly.`,
        delayMs,
        fallbackMessage: attempt >= 2 ? FALLBACK_MESSAGES.invalid_response : undefined,
        shouldRestartSession: false,
      };

    case 'unknown':
    default:
      // Generic retry with backoff
      return {
        shouldRetry: attempt < maxRetries,
        delayMs,
        fallbackMessage: attempt >= maxRetries ? FALLBACK_MESSAGES.unknown : undefined,
        shouldRestartSession: attempt >= 2,  // Restart after 2 failures
      };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
