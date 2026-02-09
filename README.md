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
- Voice input (WhisperKit STT) and optional voice output (OpenAI TTS)
- 80+ slash commands for productivity, system ops, and monitoring
- Allowlist and pairing-code access control
- Circuit breaker, watchdog, analytics, and automatic recovery paths
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
- Voice:
  - `enableTTS`, `ttsVoice`, `ttsSpeed`, `ttsInstructions`
- Security:
  - `security.commandWarningsEnabled`
  - `security.argValidationMode` (`moderate` or `strict`)

## Command groups

The command list is registered in [`src/poller.ts`](./src/poller.ts) via `setMyCommands`.

- Session: `/start`, `/help`, `/clear`, `/stats`, `/model`, `/tts`
- Productivity: `/todo`, `/note`, `/notes`, `/remind`, `/timer`, `/schedule`, `/schedules`
- Utilities: `/calc`, `/random`, `/pick`, `/uuid`, `/time`, `/date`
- AI info: `/weather`, `/define`, `/translate`
- System info: `/disk`, `/memory`, `/cpu`, `/battery`
- Files: `/ls`, `/pwd`, `/cat`, `/find`, `/size`, `/upload`, `/tree`
- Network: `/ping`, `/dns`, `/curl`, `/ports`, `/net`
- Server management: `/sys`, `/docker`, `/pm2`, `/brew`, `/git`, `/kill`, `/ps`, `/df`, `/top`, `/temp`, `/reboot`, `/sleep`, `/screenshot`, `/deploy`
- Monitoring: `/health`, `/analytics`, `/errors`
- Snippets: `/snippet`, `/snippets`
- Session management: `/session`, `/sessions`, `/context`
- Notifications: `/quiet`, `/dnd`
- Meta: `/id`, `/version`, `/uptime`

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
```

## License

MIT. See [`LICENSE`](./LICENSE).

---

Created by [Soroush Yousefpour](https://gabrimatic.info)

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/gabrimatic)
