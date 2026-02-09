#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[check] build"
npm run build

echo "[check] typecheck"
npm run typecheck

echo "[check] ok"
