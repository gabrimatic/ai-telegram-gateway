# CODEX.md

This file provides guidance to Codex Code (claude.ai/code) when working with code in this repository.

## What This Is

Telegram bot gateway that bridges messages to Claude CLI. Users send text/voice/files via Telegram, the bot pipes them to a Claude CLI child process, and streams responses back. Runs as a long-polling daemon on a host machine.

## Commands

```bash
npm run build          # TypeScript compile (src/ -> dist/)
npm run dev            # Development mode (ts-node)
npm start              # Production (node dist/index.js)

# Deploy (on host machine)
npm run build && pm2 restart telegram-gateway
pm2 logs telegram-gateway --lines 20 --nostream

# Shell shortcut (defined in ~/.zshrc, host machine only)
tg start                # pm2 start (or register if first time)
tg stop                 # pm2 stop
tg restart              # pm2 restart
tg reset                # stop, clear Telegram update queue, restart
tg status               # pm2 status
tg logs [lines]         # pm2 logs (default 50 lines)
```

No test framework. Validate by running the gateway and checking logs.

## Architecture

**Entry point:** `src/index.ts` - daemon lifecycle, PID-based single-instance lock, graceful shutdown. Initializes analytics, health monitor, scheduler, service manager, watchdog, task scheduler.

**Message flow:** Telegram -> `src/poller.ts` (grammy long-polling, allowlist check, message routing) -> `src/ai/` (provider abstraction) -> Claude CLI child process -> `src/response-handler.ts` (streaming edits to a single Telegram message) -> user.

**Two Claude CLI layers exist:**
- `src/claude.ts` - direct Claude CLI process management (older, still used by `claude-helpers.ts`)
- `src/ai/providers/claude-cli.ts` - provider-abstracted version with session management, circuit breaker, health checks
- `src/ai/index.ts` - factory that creates providers by name (`claude-cli`, `stub`)

**Voice pipeline:** Voice message -> download -> ffmpeg to WAV -> `src/voice.ts` (WhisperKit STT on localhost:50060) -> text -> Claude -> response -> `src/tts.ts` (OpenAI gpt-4o-mini-tts, OGG-OPUS output) -> voice reply.

**Key modules:**
- `src/commands.ts` - 80+ slash command handlers organized by category (productivity, utilities, info, system, server management, shell, files, network, monitoring, notifications, session management)
- `src/callbacks.ts` - inline button callback handlers for todos, timers, notes, weather, model switching, session management, reboot/sleep confirmation
- `src/claude-helpers.ts` - shared helpers for forwarding prompts to Claude from commands (weather, define, translate)
- `src/storage.ts` - JSON file persistence for allowlist, todos, notes, reminders (files in `~/.claude/`)
- `src/config.ts` - loads `config/gateway.json` merged with defaults
- `src/response-handler.ts` - `StreamingResponseHandler` that edits a Telegram message as chunks arrive (2s throttle, 3500 char overflow split, max 25 edits)
- `src/system-prompt.ts` - dynamic prompt builder with session stats and memory context
- `src/circuit-breaker.ts` - configurable failure threshold and recovery timeout

**Server management:**
- `src/system.ts` - host machine system integration: process management, Docker, PM2, Homebrew, Git, disk, network, system overview, temperature monitoring

**Task scheduling:**
- `src/task-scheduler.ts` - cron-based and one-time task scheduling. Spawns fresh Claude CLI instances per task. Persists schedules to `~/.claude/gateway/schedules.json`. Uses `node-cron` for recurring tasks.

**Self-improvement (analytics/watchdog/self-heal):**
- `src/analytics.ts` - usage tracking: message counts, response times, command usage, peak hours, error rates. Stores daily aggregates in `~/.claude/gateway/analytics/`. 30-day retention.
- `src/watchdog.ts` - proactive monitoring watchdog (60s cycle). Checks disk, memory, CPU, PM2, Docker, network, error rate spikes. Sends Telegram alerts for critical conditions via `src/alerting.ts`.
- `src/self-heal.ts` - auto-recovery: detects stuck sessions, memory pressure, disk pressure, zombie processes, repeated error patterns. Restarts sessions, runs GC, cleans temp files, kills runaway processes.
- `src/alerting.ts` - sends admin alerts via Telegram with category-based throttling.
- `src/resource-monitor.ts` - memory and disk usage monitoring with configurable thresholds.

**Snippets and shell access:**
- `src/snippets.ts` - save/run/delete command bookmarks. Persists to `~/.claude/gateway/snippets.json`.
- Shell commands: `/sh` (direct exec), `/shlong` (streaming output with message edits)

**Session management:**
- `/session` command with inline keyboard: status, kill, new session
- `/sessions` shows active sessions overview
- `/context` shows current session context info

**Notification preferences:**
- `src/notification-prefs.ts` - quiet mode and DND (do not disturb) with expiry. Persists to `~/.claude/gateway/notification-prefs.json`.

**Resilience:** Circuit breaker on Claude CLI failures. Stuck session detection (2 min inactivity). Auto-restart. 5-min request timeout. Daily session reset via `src/scheduler.ts`. Watchdog-driven self-healing. Error pattern detection with automatic recovery.

## Bot Commands (Telegram)

**Productivity:** /todo, /note, /notes, /remind, /timer, /schedule, /schedules, /snippet, /snippets
**Utilities:** /calc, /random, /pick, /uuid, /time, /date
**Info (Claude-powered):** /weather, /define, /translate
**System & Session:** /model, /tts, /clear, /session, /sessions, /context, /disk, /memory, /cpu, /battery
**Server Management:** /sys, /docker, /pm2, /brew, /git, /kill, /ports, /net, /ps, /df, /top, /temp, /reboot, /sleep, /screenshot
**Shell & Files:** /sh, /shlong, /ls, /pwd, /cat, /find, /size, /tree, /upload
**Network:** /ping, /dns, /curl
**Notifications:** /quiet, /dnd
**Monitoring:** /health, /analytics, /errors
**Meta:** /start, /help, /stats, /id, /version, /uptime

## Configuration

- `.env` - secrets (`TELEGRAM_BOT_TOKEN` required, `OPENAI_API_KEY` for TTS)
- `config/gateway.json` - runtime config (model, TTS, reset schedule, logging, alerting, resource thresholds)
- `src/env.ts` - path defaults with `TG_*` env var overrides
- `mcp-config.json` - MCP tools available to Claude CLI sessions

## Data Storage

All persistent data lives in `~/.claude/` (no database):
- `~/.claude/telegram-allowlist.json` - user allowlist and pairing codes
- `~/.claude/telegram-todos.json` - todo items
- `~/.claude/telegram-notes.json` - notes
- `~/.claude/telegram-reminders.json` - reminders
- `~/.claude/gateway/schedules.json` - scheduled tasks
- `~/.claude/gateway/snippets.json` - command snippets
- `~/.claude/gateway/notification-prefs.json` - quiet mode/DND preferences
- `~/.claude/gateway/analytics/YYYY-MM-DD.json` - daily analytics (30-day retention)

## Code Style

TypeScript strict mode, ES2022 target, commonjs output. 2-space indent, double quotes, semicolons. No test framework exists.

## Notable Patterns

- Singleton pattern for `ClaudeSession` and AI backend
- Stream-JSON protocol for Claude CLI I/O (stdin/stdout)
- Telegram message edit API for live streaming (not sending new messages)
- `<send-file>` tags in Claude responses trigger file uploads to Telegram
- JSON file storage in `~/.claude/` (no database)
- Allowlist + pairing code flow for user authorization
- Self-healing error pattern detection: 3+ of same error type in 10 min triggers automatic recovery
- Watchdog runs parallel health checks every 60s with 30-min alert cooldown per type
- Analytics are tracked per-day with automatic retention cleanup
- Task scheduler spawns isolated Claude CLI processes per task execution

## Note on README

The README still references ElevenLabs for TTS, but the code has been migrated to OpenAI gpt-4o-mini-tts. The actual TTS config fields in `config/gateway.json` are `ttsVoice`, `ttsSpeed`, `ttsInstructions` (not ElevenLabs voice IDs).
