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
3. Response handler starts typing pulses and accumulates chunks.
4. For private chats with topic mode, response handler sends throttled `sendMessageDraft` updates while text is generated.
5. Response handler streams user-visible output via message send/edit flow and keeps replies in the incoming message thread when a `message_thread_id` exists.
6. Provider returns final result, then response validator evaluates output quality.
7. Failures are classified and tracked in analytics/self-heal.
8. User gets final response or clear failure message.
9. Provider auth prompts (for example `/login`) are suppressed and converted to a gateway error response.

Draft notes:

- Draft streaming is best-effort only.
- If Telegram rejects a draft call, draft updates are disabled for that response and normal edit streaming continues.
- This fallback does not interrupt final response delivery.

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

## Auth Failure Handling

Auth failures need special treatment because they are not recoverable by restarting sessions.

**Degraded mode:**

When auth is detected as broken, the gateway enters degraded mode. In this state:

- `runClaude()` returns an error immediately without spawning a process.
- `handleMessage()` and `processTextWithClaude()` reply with a user-friendly error and return.
- Admin receives a critical alert.

**Detection layers:**

- Proactive: `checkAuthStatus()` runs `claude auth status --json` at startup and every 5 minutes.
- Reactive: `markAuthFailureIfDetected()` in the session catches auth errors in response text (two-tier regex, only on short text to avoid false positives).
- Watchdog: auth health check runs every 60 seconds as part of the watchdog cycle.
- Self-heal: `auth_required` error pattern enters degraded mode instead of restarting.

**Recovery:**

Periodic auth check (5 minutes) and watchdog (60 seconds) both call `checkAuthStatus()`. When auth is restored (admin re-authenticates the CLI), the check succeeds, degraded mode exits, and the gateway resumes normal operation. An info-level alert confirms recovery.

**Key files:**

- `src/ai/auth-check.ts` - degraded mode state, proactive auth verification, periodic timer.
- `src/ai/auth-failure.ts` - two-tier regex detection for response text.
- `src/ai/providers/claude-cli.ts` - session-level detection + degraded mode guard in `runClaude()`.
- `src/self-heal.ts` - `auth_required` pattern recovery.
- `src/watchdog.ts` - `checkAuthHealth()` in watchdog cycle.
- `src/index.ts` - startup check and periodic timer lifecycle.

## Safe Change Guidelines

- Do not change thresholds in more than one layer at once.
- Keep classifier categories stable, dashboards and alerts depend on them.
- When adding a new auto-recovery action, add a cooldown key immediately.
- Re-test both providers, resilience correctness is cross-provider.
