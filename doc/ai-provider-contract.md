# AI Provider Contract

This project supports two AI backends, `claude-cli` and `codex-cli`.

If you have ever felt unsure about where responses come from, that is normal. The two providers look similar from Telegram, but they run with different process models and stream formats.

This doc explains the shared contract first, then the provider-specific behavior that matters in production.

## Shared Contract

The Telegram layer calls `runAI(message, onChunk?, contextKey?)` through the provider abstraction.

Expected response shape:

- `success: boolean`
- `response: string`
- optional `error: string`
- optional `durationMs: number`

Shared guarantees:

- A request returns either `success: true` with text, or `success: false` with an error.
- Streaming chunks are optional, but final text must be returned.
- Provider-level circuit breakers protect against repeated failures.
- Timeout failures are surfaced as normal failed responses, not thrown to the poller.
- Providers may ignore `contextKey` when they do not support true context sessions.
- Providers may return structured gateway tags in plain text. The gateway handles:
  - `<send-file ... />` for file delivery
  - `<telegram-api method=\"...\" payload='{\"...\":...}' />` for Telegram Bot API calls (admin-only, max 20 per response)
- Follow-up response actions (`Again`, `Shorter`, `Deeper`) are decided separately via strict structured-output calls.

## Response Action Decision Contract

Primary file: `src/action-advisor.ts`

The gateway runs a second model pass after each successful AI response to decide
which follow-up action buttons to show for that specific response.

Decision guarantees:

- Uses the same active model and provider as the response turn.
- Requires strict JSON schema output with only:
  - `actions: ("regen" | "short" | "deep")[]`
- Decision is fail-closed: timeout/process/schema failure returns `[]`.
- No heuristic fallback is allowed for action visibility.
- `Context` remains visible regardless of decision result.

Provider-specific decision execution:

- Claude CLI:
  - `-p`
  - `--output-format json`
  - `--json-schema <schema-json>`
  - `--model <activeModel>`
  - `--no-session-persistence`
  - `--tools ""`
- Codex CLI:
  - `exec`
  - `--model <activeModel>`
  - `--output-schema <temp-schema-file>`
  - `--output-last-message <temp-output-file>`
  - `--ephemeral`
  - `--skip-git-repo-check`

Operational notes:

- Prompt/response inputs to the decision pass are truncated using
  `responseActions.maxPromptChars` and `responseActions.maxResponseChars`.
- Decision timeout uses `responseActions.decisionTimeoutMs`.
- Unknown providers return `[]`.

`AIStats` token fields:

- `lastInputTokens` / `lastOutputTokens`: token usage for the most recent completed turn.
- `sessionInputTokensTotal` / `sessionOutputTokensTotal`: cumulative usage in the current provider session.
- `lastContextWindow`: context window reported for the most recent turn when available.
- Legacy compatibility fields (`totalInputTokens`, `totalOutputTokens`, `contextWindow`) are still populated.

## Claude CLI Provider

Primary file: `src/ai/providers/claude-cli.ts`

Session model:

- Persistent child process per conversation key.
- Session key is Telegram-native: `chat:<chat_id>:thread:<message_thread_id|main>`.
- Message queue is isolated per key inside each long-lived `ClaudeSession`.
- Health timer checks for stuck processing every 30 seconds.
- Stuck threshold is 120 seconds of no activity while processing.

Spawn flags:

- Uses `--input-format stream-json`
- Uses `--output-format stream-json`
- Uses configured model from gateway config
- Uses configured MCP config path

Stream handling:

- Reads JSON lines from stdout.
- Collects text from `assistant` messages and `content_block_delta`.
- Finalizes on `result` event.
- Tracks last-turn usage from `usage`, cumulative session totals, and context window from `modelUsage` when present.

Failure surfaces:

- Unexpected process exit fails active request and drains queued requests with errors.
- MCP-related stderr lines are captured and returned as diagnostics in `mcpErrors`.

Operational note:

- This provider preserves conversational context per key.
- Session pool limits are enforced with idle TTL and LRU eviction from `conversation.*` config.
- Restarting a key clears only that key's context; global resets remain available.

## Codex CLI Provider

Primary file: `src/ai/providers/codex-cli.ts`

Session model:

- No persistent process.
- Spawns a fresh `codex exec` process per request.
- Keeps virtual session metadata plus token usage aggregates for stats.

Spawn flags:

- Uses `exec --json`
- Uses `--dangerously-bypass-approvals-and-sandbox`
- Uses `--skip-git-repo-check`
- Passes model with `-m`

Stream handling:

- Reads JSON lines.
- Appends text from `item.completed` where `item.type === "agent_message"`.
- Tracks errors via `error` and `turn.failed`.
- Completes on `turn.completed`.

Timeout and stuck behavior:

- Per-request timeout is 5 minutes.
- Stuck threshold helper is 3 minutes, only while request is in progress.

Operational note:

- Since each request starts a new process, there is no true persistent backend context.
- Any continuity comes from the prompt and higher-level gateway behavior.
- `contextKey` is accepted for contract compatibility but treated as a no-op.

## Provider Selection and Model Routing

Relevant files:

- `src/ai/index.ts`
- `src/provider.ts`
- `src/config.ts`

Current routing pattern:

- `haiku` and `opus` go to Claude provider.
- `codex` alias maps to `gpt-5.3-codex` in the Codex provider.
- Switching across providers forces a full session reset.

## Failure Classification Hook

Related file: `src/failure-classifier.ts`

Failures are categorized into:

- `timeout`
- `process_crash`
- `confusion`
- `mcp_tool_failure`
- `invalid_response`
- `unknown`

These categories feed self-healing and monitoring logic. They are part of the operational contract, not just logging.

## Practical Guardrails

- Keep stream parsers tolerant to unknown message types.
- Treat provider stderr as diagnostics, never as user-visible truth by itself.
- When changing CLI flags, validate both startup and response parsing in real runs.
- If you add a provider, match the shared response shape before wiring anything else.
