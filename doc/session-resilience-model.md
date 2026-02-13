# Session and Resilience Model

When failures stack up, people often lose time guessing which layer is acting. This is a shared pain in long-running bots. The good news is this gateway already has clear recovery behavior, once you view it as one system.

This doc describes that system in one place.

## Layers and Responsibility

Core files:

- `src/poller.ts`
- `src/ai/providers/claude-cli.ts`
- `src/ai/providers/codex-cli.ts`
- `src/circuit-breaker.ts`
- `src/validator.ts`
- `src/failure-classifier.ts`
- `src/self-heal.ts`
- `src/watchdog.ts`

Layer intent:

- Poller handles user traffic, routing, and in-flight control.
- Provider handles process lifecycle and streaming.
- Validator checks response quality.
- Failure classifier normalizes error types.
- Circuit breaker reduces repeated harm.
- Self-heal performs recovery actions.
- Watchdog monitors host and service signals every minute.

## Request Lifecycle

From Telegram message to final response:

1. Poller receives message and applies auth checks.
2. Poller calls AI backend through `runAI(...)`.
3. Provider streams chunks, then returns final result.
4. Response validator evaluates output quality.
5. Failures are classified and tracked in analytics/self-heal.
6. User gets final response or clear failure message.
7. Provider auth prompts (for example `/login`) are suppressed and converted to a gateway error response.

## Circuit Breaker Behavior

Provider circuit breaker protects repeated failure loops.

Claude and Codex both use the breaker with provider-specific thresholds.

General behavior:

- `closed`: normal operation.
- `open`: fail fast, no execution.
- `half-open`: test requests allowed, success closes again.

Why this matters:

- It gives the host time to recover.
- It prevents wasteful retries that would likely fail the same way.

## Response Validation Behavior

Validator file: `src/validator.ts`

Validation rejects:

- empty response
- confusion-only response
- leaked stack traces or runtime errors
- likely truncation
- loop-like near-duplicate response

Validator reasons feed failure classification and can trigger resilience paths.

## Failure Classification Contract

Classifier file: `src/failure-classifier.ts`

Main categories:

- `timeout`
- `process_crash`
- `mcp_tool_failure`
- `invalid_response`
- `confusion`
- `unknown`

These categories are used in self-heal pattern detection and alerting language.

Special handling:

- Backend authentication prompts are treated as operational failures.
- Raw CLI login instructions are not forwarded to end users.
- Gateway returns a fixed auth-outage error message and emits an admin alert.

## Self-Heal Behavior

Self-heal file: `src/self-heal.ts`

Recovery triggers:

- Repeated same error type, 3 or more times in 10 minutes.
- Session not alive.
- Memory above configured critical threshold.
- Disk above hard threshold.
- Suspected runaway provider processes.

Recovery actions:

- Restart AI session.
- Force GC when available, then re-check memory.
- Cleanup temp and old log files under pressure.
- Terminate runaway `claude` processes above CPU or memory limits.

Cooldown controls:

- 5-minute cooldown per recovery type.
- Prevents flapping recovery loops.

## Watchdog Behavior

Watchdog file: `src/watchdog.ts`

Cycle:

- Runs every 60 seconds.
- Checks disk, memory, CPU load, PM2 states, Docker states, Telegram reachability, and error-rate spikes.
- Runs self-heal checks after monitoring checks.

Alert controls:

- Watchdog has local 30-minute cooldown per alert key.
- Alerting module also has category throttling.

## Incident Reading Order

If things look unstable, this order saves time:

1. `/health` output for quick state.
2. `/errors patterns` for active failure pattern.
3. circuit breaker state from `/session`.
4. watchdog and self-heal logs.
5. provider stderr snippets for root cause clues.

## Safe Change Guidelines

- Do not change thresholds in more than one layer at once.
- Keep classifier categories stable, dashboards and alerts depend on them.
- When adding a new auto-recovery action, add a cooldown key immediately.
- Re-test both providers, resilience correctness is cross-provider.
