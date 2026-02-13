# Sentinel Loop in ai-telegram-gateway

## What It Does

Sentinel is an internal, timer-driven review cycle.
It runs operational checks without waiting for inbound chat traffic.
When the cycle finds no issue, it stays silent.
When the cycle finds a problem, it sends an admin alert.
When the finding looks like a runtime or gateway issue, sentinel also triggers self-heal checks automatically.

## Implementation Map

Core logic:
- `src/sentinel.ts`

Connected modules:
- `src/index.ts` initializes and stops the loop with process lifecycle.
- `src/commands.ts` exposes `/sentinel` controls.
- `src/poller.ts` provides the AI slot lock to prevent collisions with user turns.
- `src/system-prompt.ts` defines model-side handling notes.
- `src/config.ts` and `config/gateway.json` define runtime options.

Runtime files:
- Checklist: `~/.claude/gateway/SENTINEL.md`
- History: `~/.claude/gateway/sentinel-history.json`

## Startup and Timing

Boot sequence:
1. Gateway startup finishes bot setup.
2. A notifier callback is registered.
3. `initSentinel(notifier)` restores history and checks config.
4. If `config.sentinel.enabled` is true, `startSentinel()` arms the timer.

Scheduling behavior:
- Base interval: `sentinel.intervalMinutes * 60_000`
- First execution: 5 seconds after start
- Additional executions: fixed interval timer
- Manual execution: `/sentinel run`

Shutdown behavior:
- `stopSentinel()` is called during `SIGINT` and `SIGTERM` handling.

## Beat Pipeline

`runBeat()` applies these gates in order:

1. Re-entry lock
- If another run is active, this run exits as `skipped`.

2. Time window gate
- Uses configured timezone plus `activeHoursStart` and `activeHoursEnd`.
- Handles both normal and overnight windows.

3. Checklist gate
- Loads `SENTINEL.md`.
- If missing, unreadable, or contentless after removing Markdown headings and trimming whitespace, this run exits as `skipped`.

4. AI slot gate
- Calls `tryAcquireAISlot()`.
- If chat traffic is already using the model, this run exits as `skipped`.

5. Prompt assembly
- Includes `[SENTINEL]` marker, current timestamp, and full checklist body.
- Requires token response for healthy status.

6. Model execution
- Calls `runAI(prompt)` with timeout `BEAT_TIMEOUT_MS` (90 seconds).

7. Result handling
- `error`: failed execution or timeout
- `ack`: healthy token response, no outbound alert
- `alert`: non-ack response, sends Telegram admin alert
- `runtime/gateway alert`: non-ack alert with runtime keywords triggers self-heal checks

8. Finalization
- Always releases AI slot.
- Always clears re-entry lock.
- Runs self-heal checks when beat execution fails or runtime/gateway issues are detected.

## Healthy Token Rules

Token constant:
- `ACK_TOKEN = "SENTINEL_OK"`

Current matcher:
- Response must begin with `SENTINEL_OK`.
- Response length must be `<= ackMaxChars` (default `300`).

Ack examples:
- `SENTINEL_OK`
- `SENTINEL_OK.`
- `SENTINEL_OK - all systems nominal`

Everything else is handled as alert content.

## Alert Delivery

When classification is `alert`:
- Target user id: `TG_ADMIN_ID`
- Output format: HTML
- Header: `💓 <b>Sentinel Alert</b>`
- Body: escaped model response
- Runtime/gateway alerts include an "Auto-recovery" line in the alert text.

Failure handling:
- Missing `TG_ADMIN_ID`: warning log only
- Telegram send failure: error log only; beat cleanup still runs

## Command Surface

Supported commands:
- `/sentinel` or `/sentinel status`
- `/sentinel on`
- `/sentinel off`
- `/sentinel run`
- `/sentinel edit`
- `/sentinel edit <text>`
- `/sentinel create`
- `/sentinel interval <1-1440>`

Behavior notes:
- `on` starts timer if not active.
- `off` stops timer.
- `run` executes immediately but still applies all runtime gates.
- `edit <text>` replaces checklist content.
- `create` writes a default checklist only if file is absent.
- `interval` updates config and restarts timer when already running.

## Config Fields

`sentinel` object in config:
- `enabled`
- `intervalMinutes`
- `ackMaxChars`
- `activeHoursStart`
- `activeHoursEnd`
- `timezone`

Current defaults in code:
- `enabled: false`
- `intervalMinutes: 30`
- `ackMaxChars: 300`
- `activeHoursStart: 8`
- `activeHoursEnd: 23`
- `timezone: "Europe/Berlin"`

Repository config currently enables sentinel with the same timing defaults.

## Operational Risks

- No checklist file means no checks are performed.
- Very short intervals increase model usage and alert volume.
- If admin id is not configured, alerts are generated but not delivered.
- Timeout or model failure produces `error` history entries.
- Runtime/gateway alerts can trigger recovery actions that restart sessions or clean resources.

## References

- `src/sentinel.ts`
- `src/index.ts`
- `src/commands.ts`
- `src/poller.ts`
- `src/system-prompt.ts`
- `src/config.ts`
- `config/gateway.json`
