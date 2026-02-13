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
2. Poller derives a Telegram-native conversation key:
   - `chat:<chat_id>:thread:<message_thread_id>` for topic messages
   - `chat:<chat_id>:thread:main` for non-topic messages
3. Poller optionally injects bounded reply context from `reply_to_message`:
   - author display name (if available)
   - replied text/caption snippet
   - current user message block
4. Poller calls AI backend through `runAI(..., contextKey)`.
5. Response handler starts typing pulses and accumulates chunks.
6. For private chats with topic mode, response handler sends throttled `sendMessageDraft` updates while text is generated.
7. Response handler streams user-visible output via message send/edit flow and keeps replies in the incoming message thread when a `message_thread_id` exists.
8. On finalize, gateway executes `<telegram-api ... />` tags first (admin-only, max 20), then processes `<send-file ... />` tags, then sends cleaned text.
9. Provider returns final result, then response validator evaluates output quality.
10. Failures are classified and tracked in analytics/self-heal.
11. User gets final response or clear failure message.
12. Provider auth prompts (for example `/login`) are suppressed and converted to a gateway error response.

Draft notes:

- Draft streaming is best-effort only.
- If Telegram rejects a draft call, draft updates are disabled for that response and normal edit streaming continues.
- This fallback does not interrupt final response delivery.

## Keyed Session Lifecycle

Claude provider now manages a session pool keyed by Telegram conversation key instead of one global singleton.

Per-key guarantees:

- No cross-key message routing. A key is never sent to another key's process.
- Queueing is per key because each key has its own `ClaudeSession`.
- Stuck detection and restart are per key by default.

Pool controls (from `config/gateway.json`):

- `conversation.maxActiveSessions` (default: `24`)
- `conversation.idleTtlMinutes` (default: `30`)
- `conversation.replyContextMaxChars` (default: `500`)
- `conversation.enableReplyContextInjection` (default: `true`)
- `responseActions.enabled` (default: `true`)
- `responseActions.decisionTimeoutMs` (default: `5000`)
- `responseActions.maxPromptChars` (default: `2000`)
- `responseActions.maxResponseChars` (default: `4000`)

Response action decision behavior:

1. After a successful response, gateway asks the active model to return a strict
JSON action set (`regen`, `short`, `deep`) for that response only.
2. If decision fails for any reason (timeout/process/schema), action set is empty.
3. `Context` button stays available regardless of decision result.
4. Typed cues (`again`, `shorter`, `deeper`) remain available even when no action
buttons are shown.

Eviction behavior:

1. Idle TTL cleanup removes non-busy sessions older than `idleTtlMinutes`.
2. If pool size still exceeds `maxActiveSessions`, least-recently-used non-busy sessions are evicted.
3. Busy sessions are never evicted while processing queued/in-flight work.

Operational logs include:

- `conversationKey`
- `sessionId`
- `evictionReason` (`idle_ttl`, `lru_limit`, `restart`, `stop`, `stop_all`)

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

- Restart AI sessions (per-key by default when the failing key is known, global reset path still available for watchdog/self-heal).
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
