/**
 * Detect backend authentication prompts that should never be shown to end users.
 * These are operational errors that require host-side re-authentication.
 *
 * Two-tier detection to eliminate false positives:
 *
 *   Tier 1 (exact): anchored regexes that match the WHOLE text as an auth
 *   error.  Applied to text up to 200 chars.
 *
 *   Tier 2 (loose): substring regexes, but only on very short text (< 80
 *   chars) where the entire response IS the error message.
 *
 * A 500-char Claude response that quotes "Not logged in" from memory
 * context will never trigger either tier.
 */

const MAX_EXACT_LENGTH = 200;
const MAX_LOOSE_LENGTH = 80;

/** Anchored patterns - the whole (trimmed) text must be the auth error. */
const EXACT_AUTH_PATTERNS: RegExp[] = [
  /^\s*not\s+logged\s+in\s*[-:.]?\s*please\s+run\s*\/login\s*\.?\s*$/i,
  /^\s*please\s+run\s*\/login\s*\.?\s*$/i,
  /^\s*authentication\s+(is\s+)?required\s*\.?\s*$/i,
  /^\s*not\s+logged\s+in\s*\.?\s*$/i,
  /^\s*reauthenticate\s*\.?\s*$/i,
  /^\s*claude\s+auth\s+login\s*$/i,
];

/** Loose substring patterns - only trusted on very short text. */
const LOOSE_AUTH_PATTERNS: RegExp[] = [
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
  if (!normalized) return false;

  // Tier 1: exact match on text up to 200 chars
  if (normalized.length <= MAX_EXACT_LENGTH) {
    if (EXACT_AUTH_PATTERNS.some((p) => p.test(normalized))) return true;
  }

  // Tier 2: loose match only on very short text (< 80 chars)
  if (normalized.length <= MAX_LOOSE_LENGTH) {
    return LOOSE_AUTH_PATTERNS.some((p) => p.test(normalized));
  }

  return false;
}
