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

## Scheduled Prompt Shows `(no output)` or Fast-Fails

**Symptoms:**
- Schedule history entries fail in under 1 second
- Result text is `(no output)` or empty for prompt jobs
- Random check-ins miss expected generated text

**Root cause:**
Claude CLI stream-json print mode requires `--verbose` with current releases. Without it, the process exits immediately and writes the actual reason to stderr. Older scheduler code could classify this path ambiguously and hide stderr details.

**Fix (already applied):**
- Scheduler prompt execution now includes `--verbose` with stream-json mode.
- Scheduler captures bounded stderr and uses it as failure output when model output is empty.
- Stream-json `result` messages with `is_error: true` are treated as failures.
- Prompt jobs retry once on fast startup failures with no model output.
- Random check-ins send a compact fallback nudge if execution fails.

**Verification:**
1. Run `npm run typecheck && npm run build`
2. Trigger a prompt schedule and confirm `task_completed ... success:true` in logs for healthy runs
3. For forced failures, confirm schedule history contains real diagnostics (stderr or structured process-exit reason), not `(no output)`

## Duplicate or Missing Scheduler Runs Around Reload/Restart

**Symptoms:**
- Same schedule appears to execute twice around reload/restart windows
- Or a due schedule is active but did not execute

**Current behavior:**
- Scheduler now uses persisted run leases to enforce at-most-once execution for each due trigger.
- If a fresh lease exists, concurrent trigger paths skip execution (`task_skipped_lease_active`).
- If a lease is stale, scheduler recovers it and marks prior run failed before allowing another run.

**Verification:**
1. Inspect schedule record in `~/.claude/gateway/schedules.json` for lease fields (`runLeaseToken`, timestamps)
2. Check logs for `task_skipped_lease_active` and `runtime_reconcile`
3. Confirm stale-lease recovery entries are added to schedule history when applicable

## Task Succeeded But User Did Not Receive Output

**Symptoms:**
- History shows successful execution, but Telegram/file/email output is missing

**Current behavior:**
- Execution result and delivery result are tracked separately.
- Delivery failures are logged as `task_output_delivery_failed`.
- History appends delivery warnings while preserving execution success semantics.

**Verification:**
1. Check `task_completed` event for execution status
2. Check `task_output_delivery_failed` logs for channel-specific errors
3. Confirm history contains a `Delivery warnings:` block

## Quick Scheduler Health Check

1. Confirm recurring `runtime_reconcile` logs every ~60 seconds
2. Look for non-zero repair counts in reconcile summaries
3. If watchdog reports scheduler mismatch repeatedly, confirm reconcile is being triggered and mismatch clears in subsequent cycles
