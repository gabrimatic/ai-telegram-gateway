export type CircuitBreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeoutMs: number;
  successThreshold?: number;
}

export class CircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerError";
  }
}

export class CircuitBreaker {
  private state: CircuitBreakerState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly successThreshold: number;

  constructor(config: CircuitBreakerConfig) {
    this.failureThreshold = config.failureThreshold;
    this.recoveryTimeoutMs = config.recoveryTimeoutMs;
    this.successThreshold = config.successThreshold ?? 2;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (this.shouldAttemptRecovery()) {
        this.transitionTo("half-open");
      } else {
        throw new CircuitBreakerError("Circuit breaker is open");
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  getState(): CircuitBreakerState {
    // Check for automatic recovery transition
    if (this.state === "open" && this.shouldAttemptRecovery()) {
      this.transitionTo("half-open");
    }
    return this.state;
  }

  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
  }

  private shouldAttemptRecovery(): boolean {
    if (this.lastFailureTime === null) return false;
    return Date.now() - this.lastFailureTime >= this.recoveryTimeoutMs;
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.transitionTo("closed");
      }
    } else if (this.state === "closed") {
      // Reset failure count on success in closed state
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      // Any failure in half-open state returns to open
      this.transitionTo("open");
    } else if (this.state === "closed") {
      this.failureCount++;
      if (this.failureCount >= this.failureThreshold) {
        this.transitionTo("open");
      }
    }
  }

  private transitionTo(newState: CircuitBreakerState): void {
    const previousState = this.state;
    this.state = newState;
    if (newState === "closed") {
      this.failureCount = 0;
      this.successCount = 0;
    } else if (newState === "half-open") {
      this.successCount = 0;
    }
    // Emit transition for observability (can be hooked by callers)
    if (previousState !== newState && this.onStateChange) {
      try {
        this.onStateChange(previousState, newState);
      } catch {
        // Ignore callback errors
      }
    }
  }

  /** Optional callback for state transitions */
  onStateChange: ((from: CircuitBreakerState, to: CircuitBreakerState) => void) | null = null;

  /** Get failure count for diagnostics */
  getFailureCount(): number {
    return this.failureCount;
  }

  /** Get time since last failure in ms, or null if no failures recorded */
  getTimeSinceLastFailure(): number | null {
    if (this.lastFailureTime === null) return null;
    return Date.now() - this.lastFailureTime;
  }
}
