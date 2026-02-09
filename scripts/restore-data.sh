#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${TG_DATA_DIR:-$HOME/.claude}"
BACKUP_DIR="${TG_BACKUP_DIR:-$HOME/Backups/telegram-gateway}"
ARCHIVE_PATH="${1:-}"

if [ -z "$ARCHIVE_PATH" ]; then
  ARCHIVE_PATH="$(ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | head -n 1 || true)"
fi

if [ -z "$ARCHIVE_PATH" ] || [ ! -f "$ARCHIVE_PATH" ]; then
  echo "Backup archive not found. Pass a .tar.gz path or place backups in $BACKUP_DIR" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET_DIR")"
rm -rf "$TARGET_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$(dirname "$TARGET_DIR")"

echo "Restore complete from: $ARCHIVE_PATH"
echo "Restored to: $TARGET_DIR"
