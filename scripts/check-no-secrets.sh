#!/usr/bin/env bash
set -euo pipefail

patterns=(
  'AKIA[0-9A-Z]{16}'
  'AIza[0-9A-Za-z\-_]{35}'
  'ghp_[0-9A-Za-z]{36}'
  'xox[baprs]-[0-9A-Za-z-]+'
  '-----BEGIN (RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----'
  '[0-9]{9,}:[A-Za-z0-9_-]{35}'
)

files=$(git ls-files)

found=0
for pattern in "${patterns[@]}"; do
  if echo "$files" | xargs rg -n --pcre2 "$pattern" >/tmp/secret_scan_matches.txt 2>/dev/null; then
    echo "Pattern matched: $pattern"
    cat /tmp/secret_scan_matches.txt
    found=1
  fi
done

if [[ $found -ne 0 ]]; then
  echo "Secret scan failed"
  exit 1
fi

echo "Secret scan passed"
