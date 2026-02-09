#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${TG_DATA_DIR:-$HOME/.claude}"
BACKUP_DIR="${TG_BACKUP_DIR:-$HOME/Backups/telegram-gateway}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_PATH="$BACKUP_DIR/claude-backup-$TIMESTAMP.tar.gz"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Source directory not found: $SOURCE_DIR" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
tar -czf "$ARCHIVE_PATH" -C "$(dirname "$SOURCE_DIR")" "$(basename "$SOURCE_DIR")"

echo "Backup created: $ARCHIVE_PATH"
