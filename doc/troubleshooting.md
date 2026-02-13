# Troubleshooting

Common failure modes, what they look like, why they happen, and how to fix them.

## CLI Auth Token Expired

**Symptoms:**
- All messages get "AI backend authentication is unavailable" error
- Logs show `auth_failure_detected` and `degraded_mode_entered`
- Admin alert: "CLI authentication expired"

**Root cause:**
Claude CLI stores OAuth credentials in macOS keychain. PM2 inherits keychain access from the shell that started it. After reboots or security context changes, the daemon can lose keychain access, and the CLI reports "Not logged in - Please run /login".

**Fix:**
1. SSH into the host
2. Run `pm2 env telegram-gateway` to check the process environment
3. Re-authenticate: `npm run pm2:claude-auth:login`
4. Verify: `npm run pm2:claude-auth:status`
5. The gateway's periodic auth check (every 5 minutes) will auto-detect recovery and exit degraded mode
6. Or restart manually: `pm2 restart telegram-gateway`

**Prevention:**
- The gateway runs a proactive auth check at startup and every 5 minutes
- When auth fails, the gateway enters degraded mode instead of spawning sessions that die immediately
- Watchdog also includes auth in its health cycle

## Auth Detection False Positives

**Symptoms:**
- Valid Claude responses incorrectly flagged as auth errors
- Responses containing quoted auth-related text (from memory context) trigger "backend auth failure"
- Admin gets spurious "auth expired" alerts

**Root cause:**
The old auth detection used loose regex matching on responses of any length. If Claude's response quoted text like "Not logged in" from memory context, the detection triggered incorrectly.

**Fix (already applied):**
Auth detection now uses two tiers:
- Exact patterns (anchored): only match when the entire text IS the error, up to 200 chars
- Loose patterns: only match on very short text (< 80 chars)

A 500-char Claude response quoting "Not logged in" from memory will never trigger either tier.

**Prevention:**
The `markAuthFailureIfDetected` method in `claude-cli.ts` also stops checking once the response buffer exceeds 200 characters, since real auth errors are always short.

## Junk Files from Child CLI Sessions

**Symptoms:**
- Directories with ANSI escape codes in their names appear in the project root or home directory
- `.credentials.json`, `.claude.json` files appear outside expected locations
- `git status` shows unexpected untracked files

**Root cause:**
Child Claude CLI sessions can execute shell commands. If the working directory is set to `$HOME` or the project root, file-writing operations land in those directories. ANSI escape codes in directory names come from garbled terminal output being interpreted as paths.

**Fix:**
1. Delete the junk files/directories manually
2. The sandbox directory (`~/.claude/gateway/sandbox/`) is now the default working directory for child CLI processes

**Prevention:**
- `TG_WORKING_DIR` defaults to `~/.claude/gateway/sandbox/` instead of `$HOME`
- `.gitignore` includes recursive patterns for credential files and escape-code directory names
- Set `TG_WORKING_DIR` env var to override the sandbox path if needed

## Self-Heal Restart Loops on Auth Failures

**Symptoms:**
- Rapid session restarts in logs
- Self-heal triggers `session_restart` repeatedly
- No recovery despite multiple restarts
- High CPU from process churn

**Root cause:**
The old self-heal treated auth failures like any other error: restart the session. But restarting doesn't fix authentication - the new session dies the same way, recording another error, triggering another restart.

**Fix (already applied):**
Self-heal now has an `auth_required` error type handler that enters degraded mode instead of restarting the session. Degraded mode stops all new session spawning. The periodic auth check (every 5 minutes) detects when auth is restored and exits degraded mode automatically.

**Prevention:**
- Auth failures are classified as `auth_required` in error tracking
- Self-heal pattern recovery for `auth_required` enters degraded mode, never restarts
- The circuit breaker also prevents repeated failures from hammering the CLI
