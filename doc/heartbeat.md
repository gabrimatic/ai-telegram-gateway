# Heartbeat in ai-telegram-gateway

## Purpose

Heartbeat is the gateway's proactive turn loop.

Its main purpose is to run periodic checks without waiting for a user message, then notify only when something needs attention. In normal healthy cycles, it should stay quiet.

Why it exists in this project:
- Keep routine monitoring inside the same long-lived AI session used for normal chat.
- Reduce noise by suppressing plain "all clear" replies.
- Allow one checklist (`HEARTBEAT.md`) to drive repeated operational checks.
- Avoid racing with user traffic by skipping when AI is busy.

## Where It Lives in the Codebase

Primary implementation:
- `src/heartbeat.ts`

Wiring and integration:
- `src/index.ts` (startup and shutdown lifecycle)
- `src/commands.ts` (`/heartbeat` control commands)
- `src/poller.ts` (AI slot lock used as busy guard)
- `src/system-prompt.ts` (heartbeat behavior reminder in system prompt)
- `src/config.ts` and `config/gateway.json` (heartbeat configuration)

Checklist path used by runtime:
- `~/.claude/gateway/HEARTBEAT.md`

## Lifecycle and Scheduling

### Startup path

At daemon startup (`src/index.ts`):
1. Bot is initialized.
2. A notifier callback is created to send Telegram Markdown messages.
3. `initHeartbeat(notifier)` is called.

`initHeartbeat()` (`src/heartbeat.ts`) does:
- Ensures `~/.claude/gateway/` exists.
- Stores the notifier callback.
- Reads config.
- Starts heartbeat only if `config.heartbeat.enabled` is true.

### Runtime schedule

`startHeartbeat()` sets a `setInterval` loop using:
- `intervalMs = heartbeat.intervalMinutes * 60 * 1000`

Important behavior:
- A first beat runs automatically 5 seconds after start (no waiting for a full interval).
- Subsequent beats follow the configured interval.
- Manual immediate run is also available via `/heartbeat run`.

### Shutdown path

At shutdown (`SIGINT`/`SIGTERM`), daemon calls `stopHeartbeat()` before exiting.

## Beat Execution Flow (Actual Code Behavior)

Each beat goes through the same flow in `runBeat()`:

1. Re-entrancy guard
- If `beatInProgress` is already true, beat is skipped.

2. Active-hours guard
- Checks current hour in configured IANA timezone.
- Supports regular windows (`start <= end`) and overnight wrap (`start > end`).
- Outside active hours, beat is skipped.

3. Checklist guard
- Reads `~/.claude/gateway/HEARTBEAT.md`.
- If file is missing, unreadable, or effectively empty, beat is skipped.
- "Effectively empty" means lines matching Markdown headers (`# ...`) are removed, then remaining content is trimmed; if nothing remains, it is treated as empty.

4. Busy guard (atomic slot acquire)
- Calls `tryAcquireAISlot()` from `src/poller.ts`.
- If AI is processing user traffic, beat is skipped.
- This prevents races between check and acquire.

5. Prompt build
- Builds a dedicated heartbeat prompt that includes:
  - `[HEARTBEAT]` marker,
  - "scheduled check" context,
  - "reply HEARTBEAT_OK if nothing needs attention",
  - current ISO timestamp,
  - full `HEARTBEAT.md` content between markers.

6. AI execution
- Calls `runAI(prompt)`.
- Wrapped with a 90 second timeout (`BEAT_TIMEOUT_MS = 90_000`).

7. Response classification
- Failure result: history records `error`.
- Success with ack response: history records `ack`, no outbound message.
- Success with non-ack response: history records `alert`, sends Telegram alert to admin.

8. Final cleanup
- Always releases AI slot with `releaseAISlot()`.
- Always resets `beatInProgress`.

## Ack Contract and Suppression

Ack token constant:
- `ACK_TOKEN = "HEARTBEAT_OK"`

Current ack matcher in this repo:
- Trim response.
- Check that response starts with `HEARTBEAT_OK`.
- If total trimmed length is within `ackMaxChars` (default 300), treat as ack.

Examples treated as ack:
- `HEARTBEAT_OK`
- `HEARTBEAT_OK.`
- `HEARTBEAT_OK - all systems nominal`
- Any response starting with `HEARTBEAT_OK` and under 300 chars total

Everything else (doesn't start with token, or exceeds `ackMaxChars`) is treated as alert text.

## Notification Behavior

For non-ack responses:
- Destination is `process.env.TG_ADMIN_ID`.
- Message template:
  - Header: `💓 <b>Heartbeat Alert</b>`
  - Body: HTML-escaped AI response.
- Parse mode: HTML (preserves code blocks and formatting better than Markdown escaping).

If `TG_ADMIN_ID` is missing:
- A warning is logged.
- No Telegram alert is sent.

If Telegram send fails:
- Error is logged.
- Beat flow still completes normally.

## State, History, and Observability

In-memory state in `src/heartbeat.ts`:
- `heartbeatInterval`
- `beatInProgress`
- `lastBeatTime`
- `enabled`
- `history` (max 20 entries)

History entry schema:
- `timestamp`
- `result`: `ack | alert | skipped | error`
- optional `message`
- optional `durationMs`

Exposed helper APIs:
- `isHeartbeatRunning()`
- `triggerBeat()`
- `getHeartbeatStatus()`
- `getHeartbeatHistory()`
- `getHeartbeatMdPath()`
- `getHeartbeatMdContent()`

Persistence behavior:
- Heartbeat history is persisted to `~/.claude/gateway/heartbeat-history.json`.
- History is loaded from disk on startup and saved after each beat.
- Max 20 entries are retained.

## User Controls (`/heartbeat`)

Implemented subcommands in `src/commands.ts`:
- `/heartbeat` or `/heartbeat status`
- `/heartbeat on`
- `/heartbeat off`
- `/heartbeat run`
- `/heartbeat edit` - show current HEARTBEAT.md
- `/heartbeat edit <text>` - replace HEARTBEAT.md content
- `/heartbeat create` - bootstrap a default HEARTBEAT.md if none exists
- `/heartbeat interval <1-1440>`

Operational behavior details:
- `/heartbeat on` starts interval loop if not running.
- `/heartbeat off` stops loop.
- `/heartbeat run` triggers an immediate beat, but still obeys same guards (active hours, checklist existence/effective emptiness, busy guard).
- `/heartbeat edit <text>` writes the provided text to HEARTBEAT.md, enabling inline editing from Telegram.
- `/heartbeat create` creates a default checklist with system health, network, and service checks.
- `/heartbeat interval` updates config on disk and restarts timer if currently running.

## Configuration in This Project

Heartbeat config object in `src/config.ts`:
- `enabled: boolean`
- `intervalMinutes: number`
- `ackMaxChars: number`
- `activeHoursStart: number`
- `activeHoursEnd: number`
- `timezone: string`

Defaults in code:
- `enabled: false`
- `intervalMinutes: 30`
- `ackMaxChars: 300`
- `activeHoursStart: 8`
- `activeHoursEnd: 23`
- `timezone: "Europe/Berlin"`

Current repo config (`config/gateway.json`) sets:
- `enabled: true`
- `intervalMinutes: 30`
- `ackMaxChars: 300`
- `activeHoursStart: 8`
- `activeHoursEnd: 23`
- `timezone: "Europe/Berlin"`

## upstream Concepts This Implementation Follows

From upstream heartbeat docs, the concepts relevant to this codebase are:
- Heartbeat runs periodic turns in the main session.
- `HEARTBEAT.md` can define checklist behavior.
- `HEARTBEAT_OK` is used as ack token for suppression behavior.
- Active-hour windows can skip beats outside local time window.
- Heartbeat is cost-sensitive because each beat is a real model turn.

upstream also documents richer heartbeat options (for example per-channel delivery controls, account-level overrides, model override, reasoning delivery). Those are upstream platform capabilities, not all are implemented in this gateway codebase.

This repository intentionally does not implement heartbeat-specific model override. `src/heartbeat.ts` documents that switching model would restart the Claude session and lose the context heartbeat is designed to leverage.

## Practical Usage Guidance for This Repo

Checklist design (`HEARTBEAT.md`):
- Keep it short and stable.
- Use explicit, checkable items.
- Avoid long prose that increases token cost every beat.

Cadence design:
- 30m is a reasonable default.
- Lower intervals increase cost and may add noise.

Noise control:
- Keep ack path clean by ensuring "no issue" output is exactly `HEARTBEAT_OK`.
- Write checklist instructions so alerts are concise and actionable.

Safety:
- Do not put secrets in `HEARTBEAT.md`.

## Edge Cases and Failure Modes

- Missing checklist file: beat skips.
- Checklist with only headers/whitespace: beat skips.
- AI busy with user traffic: beat skips.
- Outside active hours: beat skips.
- Beat timeout (>90s): beat errors.
- AI returns failure object: beat errors.
- No `TG_ADMIN_ID`: alert cannot be delivered.
- Telegram send failure: alert delivery fails but beat state is still cleaned up.

## Source References

Code references used:
- `src/heartbeat.ts`
- `src/index.ts`
- `src/commands.ts`
- `src/poller.ts`
- `src/system-prompt.ts`
- `src/config.ts`
- `config/gateway.json`

