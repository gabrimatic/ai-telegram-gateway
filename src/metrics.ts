import { getConfig } from "./config";
import { FailureCategory } from "./failure-classifier";

export interface QualityMetrics {
  totalRequests: number;
  validResponses: number;
  retriedRequests: number;
  consecutiveFailures: number;
  validResponseRate: number;
  retryRate: number;
  failuresByCategory: Record<FailureCategory, number>;
}

interface MetricsState {
  totalRequests: number;
  validResponses: number;
  retriedRequests: number;
  consecutiveFailures: number;
  failuresByCategory: Record<FailureCategory, number>;
  recentResults: boolean[];  // true = success, false = failure (last 20)
}

const state: MetricsState = {
  totalRequests: 0,
  validResponses: 0,
  retriedRequests: 0,
  consecutiveFailures: 0,
  failuresByCategory: {
    timeout: 0,
    process_crash: 0,
    confusion: 0,
    mcp_tool_failure: 0,
    invalid_response: 0,
    unknown: 0,
  },
  recentResults: [],
};

const MAX_RECENT_RESULTS = 20;

function addRecentResult(success: boolean): void {
  state.recentResults.push(success);
  if (state.recentResults.length > MAX_RECENT_RESULTS) {
    state.recentResults.shift();
  }
}

export function recordSuccess(): void {
  state.totalRequests++;
  state.validResponses++;
  state.consecutiveFailures = 0;
  addRecentResult(true);
}

export function recordFailure(category: FailureCategory): void {
  state.totalRequests++;
  state.consecutiveFailures++;
  state.failuresByCategory[category]++;
  addRecentResult(false);
}

export function recordRetry(): void {
  state.retriedRequests++;
}

export function resetMetrics(): void {
  state.totalRequests = 0;
  state.validResponses = 0;
  state.retriedRequests = 0;
  state.consecutiveFailures = 0;
  state.failuresByCategory = {
    timeout: 0,
    process_crash: 0,
    confusion: 0,
    mcp_tool_failure: 0,
    invalid_response: 0,
    unknown: 0,
  };
  state.recentResults = [];
}

export function getMetrics(): QualityMetrics {
  const validResponseRate = state.totalRequests > 0
    ? state.validResponses / state.totalRequests
    : 1;

  const retryRate = state.totalRequests > 0
    ? state.retriedRequests / state.totalRequests
    : 0;

  return {
    totalRequests: state.totalRequests,
    validResponses: state.validResponses,
    retriedRequests: state.retriedRequests,
    consecutiveFailures: state.consecutiveFailures,
    validResponseRate,
    retryRate,
    failuresByCategory: { ...state.failuresByCategory },
  };
}

export function getRecentValidResponseRate(): number {
  if (state.recentResults.length === 0) return 1;

  const successes = state.recentResults.filter(r => r).length;
  return successes / state.recentResults.length;
}

export function shouldResetSession(): boolean {
  const config = getConfig();

  // Need at least 10 requests to make a decision
  if (state.recentResults.length < 10) {
    return false;
  }

  // Check recent valid response rate
  const recentRate = getRecentValidResponseRate();
  if (recentRate < config.validResponseRateThreshold) {
    return true;
  }

  // Check consecutive failures
  if (state.consecutiveFailures >= config.consecutiveFailureThreshold) {
    return true;
  }

  return false;
}

export function formatMetrics(): string {
  const m = getMetrics();
  const lines = [
    `Quality Metrics:`,
    `  Valid rate: ${(m.validResponseRate * 100).toFixed(1)}%`,
    `  Retry rate: ${(m.retryRate * 100).toFixed(1)}%`,
    `  Consecutive failures: ${m.consecutiveFailures}`,
    `  Total requests: ${m.totalRequests}`,
  ];

  // Add failure breakdown if there are any
  const hasFailures = Object.values(m.failuresByCategory).some(v => v > 0);
  if (hasFailures) {
    lines.push(`  Failures by type:`);
    for (const [category, count] of Object.entries(m.failuresByCategory)) {
      if (count > 0) {
        lines.push(`    ${category}: ${count}`);
      }
    }
  }

  return lines.join('\n');
}
