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

Every trigger calls one dispatcher: `runScheduledTask(schedule)`.

Dispatch by `jobType`:

- `prompt`: spawn fresh Claude CLI process, single-turn stream-json exchange.
- `shell`: run shell command with timeout.
- `script`: map extension to interpreter, then run as shell task.

Task timeout:

- 3 minutes (`TASK_TIMEOUT_MS`).

Important detail:

- Scheduled `prompt` jobs do not use the live main chat session.
- They run in isolated, fresh provider processes.

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
- `/schedules`
- `/schedule cancel <id>`
- `/schedule history [id]`

CLI surface exists for create/list/update/cancel/history via `dist/schedule-cli.js`.

## Practical Maintenance Notes

- Keep output target explicit when creating schedules, default is easy to forget.
- Treat `email:` output as optional infrastructure, it depends on local `gog` setup.
- Use `reloadSchedules()` after external edits to `schedules.json`.
- For incident debugging, inspect per-schedule `history` first, then runtime logs.
