# Deploy and Rollback

Deploy issues feel stressful because the failure often appears after the restart, not during the command. This project handles that with a stateful deploy flow and automatic rollback checks.

This doc explains exactly what happens.

Primary files:

- `src/deployer.ts`
- `src/index.ts`
- `src/poller.ts`

## What `/deploy` Is Designed to Guarantee

- No deploy starts when another deploy lock is active.
- Dirty git working tree blocks deploy.
- Build must pass before restart.
- In-flight Telegram requests are given a short drain window.
- Post-restart validation can trigger rollback if restart loops are detected.

## Deploy State File

State path:

- `~/.claude/gateway/deploy-state.json`

State fields:

- `status`: `idle | deploying | validating`
- `startedAt`
- `previousCommit`
- `currentCommit`
- `initiatedBy`
- `phase`

The state file is the source of truth across process restarts.

## Deploy Phases

The deployer runs these phases in order:

1. `lock`
2. `pre-flight`
3. `build`
4. `drain`
5. `restart`
6. `validating`

### 1) Lock

- If current state is not `idle`, deploy is rejected.
- A stale lock older than 5 minutes can be overridden.

### 2) Pre-flight

- Runs `git status --porcelain`.
- Any dirty output aborts deploy.
- Captures `previousCommit` from `git rev-parse HEAD`.

### 3) Build

- Runs `npm run build`.
- Build failure aborts deploy and returns state to `idle`.

### 4) Drain

- Sets internal deploy-pending flag.
- Polls in-flight message count every 500ms.
- Waits up to 15 seconds, then continues even if not fully drained.

### 5) Restart

- Captures `currentCommit`.
- Marks state as `validating`.
- Restarts PM2 app by configured name.

### 6) Validating

- On healthy startup, app calls `checkPostDeployHealth()` and resets state to `idle`.
- If crash-loop pattern is detected, rollback logic can run.

## Automatic Rollback Trigger

Rollback check runs early in startup:

- If state is `validating`, and PM2 restart count is high (`>= 3`), rollback is attempted.
- Rollback target is `previousCommit`.

Rollback steps:

1. `git checkout <previousCommit> -- .`
2. `npm run build`
3. reset deploy state to `idle`
4. exit so PM2 restarts with restored code

## Manual Rollback

`manualRollback()` follows the same principle:

- checkout previous commit into working tree
- build
- reset state

If there is no `previousCommit`, manual rollback reports a clear failure.

## Operational Risks to Keep in View

- Rollback uses `git checkout <commit> -- .`, so local uncommitted changes are not compatible with safe deploy.
- Drain timeout is short by design, long-running requests may still be interrupted on restart.
- PM2 restart count can include unrelated instability, so review host-level logs when rollback triggers.

## Minimal Runbook

Before deploy:

1. Confirm clean working tree.
2. Confirm PM2 app name is correct.
3. Confirm no known external outage in provider dependencies.

After deploy:

1. Check startup logs.
2. Run `/health`.
3. Send one real prompt and confirm streamed response path.
