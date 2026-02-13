# AI Telegram Gateway

Telegram bot gateway that forwards Telegram text, voice, and files to a local AI CLI provider, then streams results back in Telegram.

## What this project is for

This project runs as a long-polling daemon on a trusted host machine. It gives you a private Telegram control plane for:

- AI chat with persistent session context
- server and process operations
- shell and file workflows
- reminders, todos, notes, and scheduled tasks
- health monitoring and self-healing

## Key capabilities

- Multiple AI providers with model routing (`claude-cli` and `codex-cli`)
- Streaming responses via Telegram message edits
- Draft streaming (`sendMessageDraft`) for topic-enabled private chats, with automatic fallback to standard edit streaming
- Telegram-native conversation context isolation by `chat.id + message_thread_id`
- Reply-aware prompt disambiguation from `reply_to_message` (bounded snippet injection)
- Thread-aware replies: when a message arrives in a topic/thread, replies stay in the same thread
- Voice input (WhisperKit STT) and optional voice output (OpenAI TTS)
- In-chat schedule manager UI for listing and removing schedules
- Visual command center (`/menu`) with inline buttons for command groups
- Predefined random daily check-ins preset (`/schedule checkins`)
- Admin topic/group controls and generic Telegram API bridge (`/topic`, `/group`, `/tg`)
- AI-triggered Telegram API calls via `<telegram-api ... />` tags (admin-only, max 20 per response)
- 80+ slash commands for productivity, system ops, and monitoring
- Allowlist and pairing-code access control
- Circuit breaker, watchdog, analytics, and automatic recovery paths
- Sentinel runtime alerts can trigger automatic self-heal checks
- Backend auth prompts (like `/login`) are treated as gateway errors, not user-facing replies
- JSON-file persistence under `~/.claude/` (no database)

## Platform support

- macOS is the primary supported platform.
- Linux may work for parts of the feature set, but is not an official support target.
- Some commands are macOS-specific (`/temp`, `/sleep`, `/reboot`, `networkQuality`) and can fail on non-macOS hosts.

## Security and trust model

This bot is designed for admin-controlled environments. It exposes powerful host operations.

- Allowlist checks are the first access gate.
- Shell and system control commands exist and should be treated as privileged.
- Dangerous command paths can be disabled globally with `TG_ENABLE_DANGEROUS_COMMANDS=false`.
- Argument validation defaults to `security.argValidationMode=moderate`.

Dangerous command surfaces gated by `TG_ENABLE_DANGEROUS_COMMANDS` include:

- `/sh`, `/shlong`
- `/reboot`, `/sleep`
- `/git pull`
- `/brew update`, `/brew upgrade`

Recommended deployment posture for shared or internet-exposed environments:

1. Keep the allowlist small and explicit.
2. Restrict admin users to trusted operators only.
3. Set `TG_ENABLE_DANGEROUS_COMMANDS=false` unless needed.
4. Run the bot with a least-privilege OS user.

## Quick start

### 1) Clone and install

```bash
git clone https://github.com/gabrimatic/ai-telegram-gateway.git
cd ai-telegram-gateway
npm install
```

### 2) Configure environment

```bash
cp .env.example .env
```

Minimum required:

- `TELEGRAM_BOT_TOKEN` (required)
- `OPENAI_API_KEY` (optional, only needed for TTS)

### 3) Build and run

```bash
npm run build
npm start
```

For development:

```bash
npm run dev
```

## Setup helper script

`setup.sh` provides guided setup on macOS. It can install prerequisites, write `.env`, and optionally start/restart PM2.

```bash
./setup.sh --help
```

## Runtime configuration

### Prompt envelope and token usage

- The gateway injects a compact system prompt envelope on each AI turn.
- The envelope is intentionally kept short to reduce repeated token overhead while preserving safety and runtime constraints.
- Usage stats expose both last-turn token usage and cumulative session totals when providers return usage data.

### Environment variables

See [`.env.example`](./.env.example) for the full template. Frequently used values:

- Identity and safety:
  - `TG_HOST_LABEL` (default: `local host`)
  - `TG_ADMIN_NAME`
  - `TG_BOT_USERNAME`
  - `TG_PROJECT_PATH_HINT`
  - `TG_ENABLE_DANGEROUS_COMMANDS` (default: `true`)
- AI binaries:
  - `CLAUDE_BIN`
  - `CODEX_BIN`
- Data and paths:
  - `TG_DATA_DIR`, `TG_LOG_DIR`
  - `TG_MEMORY_FILE`, `TG_ALLOWLIST_FILE`
  - `TG_TODOS_FILE`, `TG_NOTES_FILE`, `TG_REMINDERS_FILE`
  - `TG_GATEWAY_CONFIG`, `TG_MCP_CONFIG`, `TG_PID_FILE`
  - `TG_WORKING_DIR`
- Voice transcription:
  - `WHISPERKIT_HOST` (default: `localhost`)
  - `WHISPERKIT_PORT` (default: `50060`)

### Gateway config file

Main runtime config is [`config/gateway.json`](./config/gateway.json).

Notable fields:

- Provider and model defaults:
  - `aiProvider` (`claude-cli` or `codex-cli`)
  - `defaultModel` (`haiku`, `opus`, `sonnet`, `codex`)
  - `providerDisplayName`
- Reliability:
  - `circuitBreaker.failureThreshold`
  - `circuitBreaker.recoveryTimeoutMs`
  - `maxRetries`, `retryBaseDelayMs`
- Conversation/session isolation:
  - `conversation.maxActiveSessions`
  - `conversation.idleTtlMinutes`
  - `conversation.replyContextMaxChars`
  - `conversation.enableReplyContextInjection`
- Follow-up action buttons:
  - `responseActions.enabled`
  - `responseActions.decisionTimeoutMs`
  - `responseActions.maxPromptChars`
  - `responseActions.maxResponseChars`
- Voice:
  - `enableTTS`, `ttsVoice`, `ttsSpeed`, `ttsInstructions`
- Security:
  - `security.commandWarningsEnabled`
  - `security.argValidationMode` (`moderate` or `strict`)

Follow-up action buttons (`Again`, `Shorter`, `Deeper`) are model-decided per response using strict JSON schema output from the active provider CLI. If decision fails, the bot fails closed (no prompt-action buttons). `Context` remains available on every response. Typed cues (`again`, `shorter`, `deeper`) remain globally available.
Hidden actions are enforced server-side, so forged callback payloads are rejected.

## Command groups

The command list is registered in [`src/poller.ts`](./src/poller.ts) via `setMyCommands`.

The slash suggestion menu includes the full top-level command surface:

- Core/session: `/start`, `/help`, `/menu`, `/stats`, `/clear`, `/new`, `/id`, `/ping`, `/version`, `/uptime`, `/model`, `/tts`, `/session`
- Productivity/info: `/todo`, `/remind`, `/timer`, `/schedule`, `/weather`, `/define`, `/translate`
- Telegram admin controls: `/topic`, `/group`, `/tg`
- Files/network/system: `/cd`, `/ls`, `/pwd`, `/cat`, `/find`, `/size`, `/curl`, `/net`, `/ps`, `/kill`, `/top`, `/temp`, `/disk`, `/memory`, `/cpu`, `/battery`
- Operations/monitoring: `/pm2`, `/git`, `/sh`, `/reboot`, `/sentinel`, `/health`, `/analytics`, `/errors`
- Access: `/pair`

## Data storage

Persistent state is file-based under `~/.claude/`, including:

- allowlist and pairing data
- todos, notes, reminders
- schedules and snippets
- notification preferences
- daily analytics snapshots

No database is required.

## Development checks

```bash
npm run typecheck
npm run build
npm run smoke
npm run e2e
npm run check:restart-resilience
npm run check:pm2-daemon
```

Current CI checks include:

- `npm ci`
- `npm run typecheck`
- `npm run build`
- `npm run smoke`
- `npm audit --omit=dev`
- secret-pattern scan
- `npm pack --dry-run`

## PM2 operations

Project scripts:

```bash
npm run pm2:start
npm run pm2:restart
npm run pm2:status
npm run pm2:logs
npm run pm2:claude-auth:status
npm run pm2:claude-auth:login
npm run pm2:shell
```

Auth troubleshooting shortcuts:

- `npm run pm2:claude-auth:status`: checks `claude auth status` in the PM2 app context.
- `npm run pm2:claude-auth:login`: runs interactive `claude auth login` in the PM2 app context.
- `npm run pm2:shell`: opens an interactive shell with PM2 app env loaded.

## License

MIT. See [`LICENSE`](./LICENSE).

---

Created by [Soroush Yousefpour](https://gabrimatic.info)

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/gabrimatic)
