import * as os from "os";
import * as path from "path";
import { getCurrentModel, getStats as getAIStats } from "./ai";

/** Format token count as compact string (e.g. 12k, 150k) */
function formatTokens(n: number): string {
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}

function getShortWorkspaceLabel(): string {
  const cwd = process.cwd();
  const home = os.homedir();
  if (cwd === home) return "~";
  const base = path.basename(cwd) || cwd;
  return base.length > 18 ? `${base.slice(0, 15)}...` : base;
}

/**
 * Build a compact, one-line context label intended for UI metadata
 * (inline button popups, debug hints, etc).
 */
export function buildResponseContextLabel(): string {
  const stats = getAIStats();
  let contextPart: string;

  if (stats?.totalInputTokens && stats.contextWindow) {
    const used = stats.totalInputTokens + (stats.totalOutputTokens || 0);
    contextPart = `${formatTokens(used)}/${formatTokens(stats.contextWindow)}`;
  } else {
    contextPart = getCurrentModel();
  }

  return `${contextPart} | ${getShortWorkspaceLabel()}`;
}
