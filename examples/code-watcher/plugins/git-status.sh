#!/bin/bash
# Git status — observe the development rhythm
REPO="${WATCH_REPO:-.}"
cd "$REPO" 2>/dev/null || exit 0

echo "=== Working Tree ==="
git status --short 2>/dev/null || echo "(not a git repo)"

echo ""
echo "=== Recent Commits ==="
git log --oneline -5 --since="24 hours ago" 2>/dev/null || echo "No recent commits"

echo ""
echo "=== Branch ==="
git branch --show-current 2>/dev/null
