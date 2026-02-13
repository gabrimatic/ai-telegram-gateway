import { getConfig } from "./config";

export type ValidationReason = 'empty' | 'confusion' | 'truncated' | 'error_leak' | 'loop';

export interface ValidationResult {
  valid: boolean;
  reason?: ValidationReason;
}

const ERROR_PATTERNS = [
  /Error:\s+\w+Error/i,
  /at\s+\S+\s+\(\S+:\d+:\d+\)/,  // Stack trace line
  /Traceback \(most recent call last\)/i,
  /ENOENT|EACCES|EPERM|ETIMEDOUT/,
  /Connection refused|Connection reset/i,
  /TypeError:|ReferenceError:|SyntaxError:/,
];

const INCOMPLETE_PATTERNS = [
  /```[^`]*$/,  // Unclosed code block
  /\.\.\.\s*$/,  // Trailing ellipsis suggesting continuation
];

function similarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;

  const shorter = a.length < b.length ? a : b;
  const longer = a.length >= b.length ? a : b;

  // For very short strings, use simple equality check
  if (shorter.length < 50) {
    return shorter === longer ? 1 : 0;
  }

  let matches = 0;
  const windowSize = Math.min(50, shorter.length);

  // Cap the number of comparisons to prevent O(n*m) on very long strings
  const maxIterations = Math.min(Math.ceil((shorter.length - windowSize) / 10) + 1, 100);
  const step = Math.max(10, Math.floor(shorter.length / maxIterations));

  for (let i = 0; i <= shorter.length - windowSize; i += step) {
    const chunk = shorter.substring(i, i + windowSize);
    if (longer.includes(chunk)) {
      matches++;
    }
  }

  const totalWindows = Math.ceil((shorter.length - windowSize) / step) + 1;
  return totalWindows > 0 ? matches / totalWindows : 0;
}

function endsWithPunctuation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // Check for code block ending
  if (trimmed.endsWith('```')) return true;

  // Check for list item (could be valid ending)
  if (/^\s*[-*]\s/.test(trimmed.split('\n').pop() || '')) return true;

  // Check for normal punctuation
  const lastChar = trimmed[trimmed.length - 1];
  return /[.!?:;)\]}"']/.test(lastChar);
}

function hasConfusionWithoutAttempt(response: string, markers: string[]): boolean {
  const lowerResponse = response.toLowerCase();

  for (const marker of markers) {
    if (lowerResponse.includes(marker.toLowerCase())) {
      // Check if there's substantial content after the confusion marker
      const markerIndex = lowerResponse.indexOf(marker.toLowerCase());
      const afterMarker = response.substring(markerIndex + marker.length).trim();

      // If there's less than 50 chars after the marker, it's likely just confusion
      if (afterMarker.length < 50) {
        return true;
      }
    }
  }

  return false;
}

function hasErrorLeak(response: string): boolean {
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(response)) {
      return true;
    }
  }
  return false;
}

function isTruncated(response: string): boolean {
  // Check for incomplete patterns
  for (const pattern of INCOMPLETE_PATTERNS) {
    if (pattern.test(response)) {
      return true;
    }
  }

  // Check if it ends without punctuation (for responses > 100 chars)
  if (response.length > 100 && !endsWithPunctuation(response)) {
    return true;
  }

  return false;
}

function isLoop(response: string, previousResponses: string[]): boolean {
  if (previousResponses.length === 0) return false;

  // Check similarity with last 3 responses
  const recentResponses = previousResponses.slice(-3);

  for (const prev of recentResponses) {
    const sim = similarity(response, prev);
    if (sim > 0.7) {
      return true;
    }
  }

  return false;
}

export function validateResponse(
  response: string,
  previousResponses: string[] = []
): ValidationResult {
  const config = getConfig();

  // Empty check
  if (!response || response.trim().length === 0) {
    return { valid: false, reason: 'empty' };
  }

  // Confusion check
  if (hasConfusionWithoutAttempt(response, config.confusionMarkers)) {
    return { valid: false, reason: 'confusion' };
  }

  // Error leak check
  if (hasErrorLeak(response)) {
    return { valid: false, reason: 'error_leak' };
  }

  // Truncation check
  if (isTruncated(response)) {
    return { valid: false, reason: 'truncated' };
  }

  // Loop check
  if (isLoop(response, previousResponses)) {
    return { valid: false, reason: 'loop' };
  }

  return { valid: true };
}
