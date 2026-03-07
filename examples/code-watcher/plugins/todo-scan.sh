#!/bin/bash
# TODO scan — find unfinished work markers
REPO="${WATCH_REPO:-.}"
cd "$REPO" 2>/dev/null || exit 0

echo "=== TODOs ==="
grep -rn --include="*.ts" --include="*.js" --include="*.py" --include="*.go" \
  -E '(TODO|FIXME|HACK|XXX):?' . 2>/dev/null | head -15 || echo "None found"
