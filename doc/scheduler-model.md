# Scheduler Model

Scheduling looks simple on the surface, but this gateway supports multiple job types, outputs, and runtime paths. If you have ever wondered why one task behaves differently from another, that question is valid.

This doc gives one clear model.

Primary files:

- `src/task-scheduler.ts`
- `src/schedule-cli.ts`
- `src/commands.ts`

## What the Scheduler Stores

Persistence file:

- `~/.claude/gateway/schedules.json`

Core schedule fields:

- `id`
- `type`: `once | cron`
- `jobType`: `prompt | shell | script`
- `task` (prompt text, shell command, or script path)
- `output`: `telegram | silent | file:/path | email:addr`
- `status`: `active | completed | cancelled | failed`
- `userId`
- timestamps (`createdAt`, `lastRun`, `nextRun`)
- lease metadata (`runLeaseToken`, `runLeaseStartedAt`, `runLeaseHeartbeatAt`)
- last failure metadata (`lastFailureKind`, `lastAttemptCount`)
- `history` with capped entries

History retention:

- Maximum 50 history entries per schedule.

## Time and Timezone Rules

The scheduler timezone is pinned in code:

- `Europe/Berlin`

Implications:

- Cron execution and display formatting use Berlin time.
- One-time schedules store ISO timestamps, then display in Berlin time.
- If host timezone differs, scheduler behavior still follows configured timezone in node-cron.

## Execution Model

Every trigger calls one dispatcher: `runScheduledTask(scheduleId)`.

Run coordination:

- Dispatcher rehydrates the latest schedule from store by ID before executing.
- A persisted run lease is claimed atomically before execution starts.
- If another process/runtime already owns a fresh lease, the trigger is skipped (`task_skipped_lease_active`).
- Stale leases are recovered and marked failed before re-execution.

Dispatch by `jobType`:

- `prompt`: spawn fresh Claude CLI process, single-turn stream-json exchange.
- `shell`: run shell command with timeout.
- `script`: map extension to interpreter, then run as shell task.
- internal reserved prompt tasks:
  - `__tg_random_checkin_master__`: daily planner for random check-ins.
  - `__tg_random_checkin_message__|...`: single check-in delivery task.

Task timeout:

- 3 minutes (`TASK_TIMEOUT_MS`).

Important detail:

- Scheduled `prompt` jobs do not use the live main chat session.
- They run in isolated, fresh provider processes.
- Scheduler prompt runs use Claude CLI with `--verbose` in stream-json mode and a sanitized child env.
- Prompt jobs short-circuit while backend auth degraded mode is active.
- Stream-json `result` messages are not assumed successful; `is_error` responses are classified as failures.
- Prompt jobs capture bounded stderr for diagnostics and retry once on fast no-output startup failures.
- Shell/script jobs do not auto-retry by default (non-idempotent safety).

## Output Routing

Output targets:

- `telegram`: notify the schedule owner in Telegram.
- `silent`: no user notification, logs only.
- `file:/path`: append result with timestamp.
- `email:addr`: send through `gog gmail send`.

Routing behavior:

- Start notification is sent for non-silent targets.
- Completion includes success or failure icon and truncated output.
- Long output is truncated for Telegram display.
- Random check-in delivery tasks skip start notifications and send only the generated short message.
- If a random check-in prompt execution fails, users still receive a deterministic fallback nudge while failure remains recorded in history/logs.
- Delivery failures (Telegram/file/email/tag execution) are recorded as delivery warnings without changing execution success.

## Runtime Reconciler

The scheduler runs a periodic reconciler every 60 seconds.

Per cycle:

- repairs missing cron handlers for active cron schedules
- repairs missing one-time timers for active once schedules
- triggers overdue one-time schedules with no timer handle
- removes orphan runtime handles for non-active schedules
- recovers stale run leases

Each cycle emits one `runtime_reconcile` event with repair/removal counts.

## In-Memory Runtime State

Runtime maps:

- active cron jobs keyed by schedule ID
- active one-time timers keyed by schedule ID

Lifecycle operations:

- `initTaskScheduler()` loads persisted active schedules and re-registers them.
- `reloadSchedules()` clears all runtime jobs, then reloads from disk.
- `stopTaskScheduler()` stops all runtime jobs and timers.

## One-Time and Cron Semantics

`once`:

- If scheduled time is already in the past at load time, it runs immediately.
- After run, status becomes `completed` or `failed`.

`cron`:

- Cron expression is validated before registration.
- `nextRun` is updated where available using node-cron next-run API.

## Command Surface

User-facing commands:

- `/schedule`
- `/schedule cancel <id>`
- `/schedule history [id]`
- `/schedule checkins [status|on|off|regen]`

CLI surface exists for create/list/update/cancel/history via `dist/schedule-cli.js`.

## Random Check-in Preset

The preset is managed via `/schedule checkins` and in-chat schedule UI buttons.

Behavior:

- Enabling creates one daily cron planner (00:05 Berlin).
- Planner generates one-time check-in schedules for the same day.
- Times are random and constrained:
  - maximum 10 messages/day
  - minimum 60 minutes between messages
  - never after 23:00 Berlin
- Generated check-ins are `prompt` jobs with short-message instructions and tool-aware context guidance.

## Practical Maintenance Notes

- Keep output target explicit when creating schedules, default is easy to forget.
- Treat `email:` output as optional infrastructure, it depends on local `gog` setup.
- Use `reloadSchedules()` after external edits to `schedules.json`.
- For incident debugging, inspect per-schedule `history` first, then runtime logs.
- Quick health check:
  - Look for recent `runtime_reconcile` logs.
  - Compare active schedules vs attached runtime handles.
  - Check for repeated `task_skipped_lease_active` and stale lease recovery messages.
