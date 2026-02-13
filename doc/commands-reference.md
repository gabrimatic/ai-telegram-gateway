# Commands Reference

This is the live command reference for the gateway as implemented in code today.

If a command in older notes does not appear here, it is likely from a previous revision. This list is based on `src/commands.ts`, so it reflects what the bot currently handles.

Primary source:

- `src/commands.ts`

Menu source:

- `src/poller.ts`

## Before You Run Commands

- Some commands are admin-only.
- Some commands are disabled when `TG_ENABLE_DANGEROUS_COMMANDS=false`.
- Unknown commands fall back to normal AI chat handling.

## Core and Session

### `/start`

Shows welcome text and quick-action buttons.

### `/help`

Shows grouped command summary.

### `/stats`

Shows gateway health stats summary.

### `/clear`

Stops current AI session, kills provider leftovers, and starts a fresh session.

### `/id`

Shows your Telegram user ID.

### `/version`

Shows gateway bot version.

### `/uptime`

Shows process uptime and start timestamp.

### `/model [name]`

- No args: show current model and model keyboard.
- With model: switches model, and may switch provider.
- Provider switch causes full session reset.

### `/tts [status|on|off]`

- No args or `status`: show voice output state.
- `on`: enable OpenAI TTS output.
- `off`: disable TTS output.

### `/session [status|kill|new]`

- No args or `status`: show current session state and counters.
- `kill`: force-kill current session and provider process.
- `new`: start a fresh session.

## Productivity

### `/todo`

Explains that todo tracking now uses scheduler flow.

### `/remind`

Explains that reminders now use scheduler flow.

### `/timer [duration] [label...]`

- No args: usage guidance.
- With duration like `30s`, `5m`, `1h`: creates one-time schedule timer.

## AI-Assisted Info

### `/weather [city]`

- No args: city buttons.
- With city: requests a concise weather summary.

### `/define <word>`

Returns concise definition with part of speech and example.

### `/translate <language> <text>`

- No args: language buttons.
- With args: translates and returns only translation.

## System Information

### `/disk`

Shows disk usage (`df -h /`).

### `/memory`

Shows memory breakdown from `vm_stat` plus total memory.

### `/cpu`

Shows CPU model, cores, and load average.

### `/battery`

Shows battery status from `pmset`.

### `/temp`

Shows temperature summary.

### `/health`

Shows health dashboard including resources, error rate, session, and watchdog state.

### `/analytics [today|week|month]`

Shows analytics summary for requested period.

### `/errors [patterns]`

- Default: recent error summary and rate.
- `patterns`: error pattern and recovery log view.

## Files and Local Navigation

### `/cd [path]`

Changes process working directory.

### `/ls [path]`

Lists files in path, capped output.

### `/pwd`

Shows current working directory.

### `/cat <path>`

Shows file content, truncated for safety.

### `/find <name>`

Finds matching files under current directory.

### `/size <path>`

Shows disk usage size for target path.

## Network and HTTP

### `/ping [host]`

- No args: simple latency response.
- With host: runs network ping summary.

### `/curl <http(s)://url>`

Fetches response headers with strict URL validation.

### `/net <subcommand>`

Subcommands:

- `connections`
- `ip`
- `speed`

## Scheduler Commands

### `/schedule`

Opens in-chat schedule manager UI with buttons for:

- active schedule list
- inactive schedule list
- removing active schedules
- random check-in preset controls

### `/schedules`

Alias for `/schedule` (same in-chat manager UI).

### `/schedule cancel <id>`

Cancels active schedule by ID.

### `/schedule history [id]`

- No ID: compact history summary across schedules.
- With ID: detailed history for one schedule.

### `/schedule checkins [status|on|off|regen]`

Manages the predefined random check-in preset:

- `status`: current preset state and queued count.
- `on`: enables daily planner and generates today’s random one-time check-ins.
- `off`: disables planner and cancels queued check-ins.
- `regen`: rebuilds today’s random check-in slots.

## Sentinel Commands

### `/sentinel`

Shows sentinel status and recent beat history.

### `/sentinel on`

Starts sentinel timer loop.

### `/sentinel off`

Stops sentinel timer loop.

### `/sentinel run`

Triggers one immediate sentinel execution.

### `/sentinel edit`

Shows current `SENTINEL.md` content if present.

### `/sentinel edit <text>`

Replaces `SENTINEL.md` content with provided text.

### `/sentinel create`

Creates default sentinel checklist if missing.

### `/sentinel interval <1-1440>`

Updates interval minutes, and restarts timer if running.

## Process and Server Operations

### `/ps [filter]`

Shows process list or filtered process view.

### `/kill <pid>`

Shows process details and attempts process kill.

### `/top`

Shows top processes by resource usage.

### `/pm2 <subcommand>`

Subcommands:

- `ls` or `list`
- `restart <name>`
- `stop <name>`
- `start <name>`
- `logs <name> [lines]`
- `flush`

### `/git <subcommand>`

Subcommands:

- `status [repo]`
- `log [repo]`
- `pull [repo]` (dangerous command gate applies)

Known repo alias in helper text:

- `gateway` (default)

### `/reboot`

Shows confirmation buttons, actual reboot requires callback confirmation.

### `/sh <command>`

Runs shell command and returns output.

This command is dangerous and can be globally disabled with `TG_ENABLE_DANGEROUS_COMMANDS=false`.

## Telegram Callback Actions (Not Slash Commands)

The bot also handles inline button callback actions:

- timer menu and preset timers
- weather menu and city shortcuts
- translate language shortcuts
- model selection buttons
- session quick actions
- reboot confirm or cancel

Callback handlers are wired in:

- `src/poller.ts`
- `src/callbacks.ts`
