/**
 * Utility functions for the Telegram Gateway bot
 */

import { execSync } from "child_process";

type ShellArgKind = "path" | "host" | "domain" | "container" | "generic";

// Parse time string like "5m", "1h", "30s" to milliseconds
export function parseTimeString(timeStr: string): number | null {
  const match = timeStr.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit];
}

// Safe math evaluation (no eval)
export function safeCalc(expression: string): string {
  // Only allow numbers, basic operators, parentheses, decimals, and spaces
  const sanitized = expression.replace(/\s/g, "");
  if (!/^[\d+\-*/().%^]+$/.test(sanitized)) {
    return "Invalid expression. Use only numbers and +, -, *, /, %, ^, (, )";
  }

  // Reject expressions that are too long (potential DoS via deeply nested expressions)
  if (sanitized.length > 200) {
    return "Expression too long (max 200 characters)";
  }

  // Reject deeply nested parentheses
  let depth = 0;
  for (const ch of sanitized) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth > 10) return "Too many nested parentheses (max 10)";
  }
  if (depth !== 0) return "Unbalanced parentheses";

  try {
    // Replace ^ with ** for exponentiation
    const jsExpr = sanitized.replace(/\^/g, "**");
    // Use Function constructor instead of eval for slightly safer execution
    const result = new Function(`"use strict"; return (${jsExpr})`)();
    if (typeof result !== "number" || !isFinite(result)) {
      return "Invalid result (infinity or NaN)";
    }
    return `${expression} = ${result}`;
  } catch {
    return "Calculation error";
  }
}

// Format uptime in human-readable form
export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(" ");
}

// Format duration in human-readable form
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds !== 1 ? "s" : ""}`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (secs === 0) return `${mins} minute${mins !== 1 ? "s" : ""}`;
  return `${mins}m ${secs}s`;
}

// Helper to get week number
export function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

// Escape Telegram Markdown V1 special characters in user-provided text
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*`\[\]])/g, "\\$1");
}

export function validateShellArg(
  arg: string,
  kind: ShellArgKind
): { ok: boolean; reason?: string } {
  if (!arg || !arg.trim()) {
    return { ok: false, reason: "argument is empty" };
  }

  const value = arg.trim();
  if (value.length > 512) {
    return { ok: false, reason: "argument is too long" };
  }

  // Block shell expansion and command chaining primitives across all kinds.
  if (/[`$\\\n\r;&|]/.test(value) || value.includes("$(") || value.includes("`")) {
    return { ok: false, reason: "contains unsafe shell characters" };
  }

  switch (kind) {
    case "path":
      return /^[a-zA-Z0-9._~\-\/ ]+$/.test(value)
        ? { ok: true }
        : { ok: false, reason: "path may only include letters, numbers, spaces, /, ., _, -, and ~" };
    case "host":
      return /^[a-zA-Z0-9.-]+$/.test(value)
        ? { ok: true }
        : { ok: false, reason: "hostname may only include letters, numbers, dots, and dashes" };
    case "domain":
      return /^[a-zA-Z0-9.-]+$/.test(value) && value.includes(".")
        ? { ok: true }
        : { ok: false, reason: "domain format is invalid" };
    case "container":
      return /^[a-zA-Z0-9_.-]+$/.test(value)
        ? { ok: true }
        : { ok: false, reason: "container/repo name may only include letters, numbers, ., _, and -" };
    case "generic":
    default:
      return /^[\x20-\x7E]+$/.test(value)
        ? { ok: true }
        : { ok: false, reason: "argument contains invalid characters" };
  }
}

// Helper function for safe shell command execution
export function safeExec(command: string, maxOutput: number = 3000): string {
  try {
    const result = execSync(command, {
      encoding: "utf-8",
      timeout: 10000, // 10 second timeout
      maxBuffer: 1024 * 1024, // 1MB buffer
    });
    if (result.length > maxOutput) {
      return result.substring(0, maxOutput) + "\n... (truncated)";
    }
    return result;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stderr" in err) {
      const execErr = err as { stderr?: string; message?: string };
      return `Error: ${execErr.stderr || execErr.message || "Command failed"}`;
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
