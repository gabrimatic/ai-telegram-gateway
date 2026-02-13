/**
 * Detect backend authentication prompts that should never be shown to end users.
 * These are operational errors that require host-side re-authentication.
 *
 * Only triggers on short text (< 200 chars) to avoid false positives from
 * Claude responses that quote or reference auth-related text from context.
 */

const MAX_AUTH_ERROR_LENGTH = 200;

const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /not\s+logged\s+in/i,
  /please\s+run\s*\/login/i,
  /run\s+\/login/i,
  /claude\s+auth\s+login/i,
  /authentication\s+(is\s+)?required/i,
  /reauthenticate/i,
];

export function isAuthFailureText(text?: string | null): boolean {
  if (!text) return false;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > MAX_AUTH_ERROR_LENGTH) return false;

  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(normalized));
}
