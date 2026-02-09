# AI Telegram Gateway

Telegram bot gateway that bridges incoming Telegram messages to a local AI CLI process and streams responses back.

## Compatibility

- macOS is the primary supported platform for this repository.
- Linux may work for some features, but is not a support target in this release.
- Some commands are macOS-specific (`/temp`, `/sleep`, `/reboot`, `networkQuality`) and will return command errors on non-macOS systems.

## Security model and trust assumptions

- This bot is intended for trusted, admin-controlled environments.
- Admin-only commands include direct shell execution and system control operations.
- Allowlist enforcement is the first access gate.
- Dangerous commands can be globally disabled with `TG_ENABLE_DANGEROUS_COMMANDS=false`.
- Input validation is moderate by default (`security.argValidationMode=moderate`) and blocks common shell-injection primitives for shell-bound command arguments.

## Dangerous admin commands and deployment posture

Dangerous commands are enabled by default to preserve current operational behavior.

Commands gated by `TG_ENABLE_DANGEROUS_COMMANDS`:
- `/sh`
- `/shlong`
- `/reboot`
- `/sleep`
- `/git pull`
- `/brew update`
- `/brew upgrade`

Recommended posture for public or shared deployments:
1. Keep allowlist tight.
2. Restrict admin users to trusted operators only.
3. Set `TG_ENABLE_DANGEROUS_COMMANDS=false` unless explicitly needed.
4. Run behind least-privilege OS users where possible.

## Quick start

```bash
git clone https://github.com/gabrimatic/ai-telegram-gateway.git
cd ai-telegram-gateway
npm install
cp .env.example .env
```

Set required environment variables in `.env`:
- `TELEGRAM_BOT_TOKEN` (required)
- `OPENAI_API_KEY` (optional, only for TTS)

Build and run:

```bash
npm run build
npm start
```

## Environment variables

Core identity and runtime labels:
- `TG_HOST_LABEL` default: `local host`
- `TG_ADMIN_NAME` default: empty
- `TG_BOT_USERNAME` default: empty
- `TG_PROJECT_PATH_HINT` default: empty
- `TG_ENABLE_DANGEROUS_COMMANDS` default: `true`

Path and runtime variables (subset):
- `TG_DATA_DIR`
- `TG_LOG_DIR`
- `TG_HEALTH_FILE`
- `TG_PROJECT_DIR`
- `TG_PM2_APP_NAME`
- `TG_MEMORY_FILE`
- `TG_ALLOWLIST_FILE`
- `TG_TODOS_FILE`
- `TG_NOTES_FILE`
- `TG_REMINDERS_FILE`
- `TG_PID_FILE`
- `TG_MCP_CONFIG`
- `TG_GATEWAY_CONFIG`
- `TG_WORKING_DIR`
- `CLAUDE_BIN`
- `CODEX_BIN`
- `WHISPERKIT_HOST`
- `WHISPERKIT_PORT`

See `.env.example` for full templates.

## Gateway config (`config/gateway.json`)

Security section:

```json
{
  "security": {
    "commandWarningsEnabled": true,
    "argValidationMode": "moderate"
  }
}
```

- `commandWarningsEnabled`: enables warning lines in help/command UX.
- `argValidationMode`: `moderate` or `strict` (current implementation defaults to and uses `moderate`).

## Commands

The README command list is synchronized with `setMyCommands` in `src/poller.ts`.

Session:
- `/start`, `/help`, `/clear`, `/stats`, `/model`, `/tts`

Productivity:
- `/todo`, `/note`, `/notes`, `/remind`, `/timer`, `/schedule`, `/schedules`

Utilities:
- `/calc`, `/random`, `/pick`, `/uuid`, `/time`, `/date`

Info:
- `/weather`, `/define`, `/translate`

System info:
- `/disk`, `/memory`, `/cpu`, `/battery`

Files:
- `/ls`, `/pwd`, `/cat`, `/find`, `/size`, `/upload`, `/tree`

Network:
- `/ping`, `/dns`, `/curl`, `/ports`, `/net`

Server management:
- `/sys`, `/docker`, `/pm2`, `/brew`, `/git`, `/kill`, `/ps`, `/df`, `/top`, `/temp`, `/reboot`, `/sleep`, `/screenshot`, `/deploy`

Monitoring:
- `/health`, `/analytics`, `/errors`

Snippets:
- `/snippet`, `/snippets`

Session management:
- `/session`, `/sessions`, `/context`

Notifications:
- `/quiet`, `/dnd`

Meta:
- `/id`, `/version`, `/uptime`

## Development and checks

```bash
npm run typecheck
npm run build
npm run smoke
npm run e2e
npm run check:restart-resilience
npm run check:pm2-daemon
```

CI enforces:
- `npm ci`
- `npm run typecheck`
- `npm run build`
- `npm run smoke`
- `npm audit --omit=dev`
- secret-pattern scan
- `npm pack --dry-run`

## Packaging

`package.json` uses a whitelist `files` field to control publish artifacts.

## License

MIT. See `LICENSE`.

---

Created by [Soroush Yousefpour](https://gabrimatic.info)

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/gabrimatic)
