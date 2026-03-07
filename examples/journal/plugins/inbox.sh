#!/bin/bash
# Inbox — check for messages
DIR="./examples/journal/inbox"
files=$(find "$DIR" -type f -name "*.txt" 2>/dev/null | sort)
if [ -z "$files" ]; then
  echo "(no messages)"
  exit 0
fi
count=$(echo "$files" | wc -l | tr -d ' ')
echo "=== $count message(s) ==="
echo "$files" | while read -r f; do
  echo "--- $(basename "$f") ---"
  head -20 "$f"
  echo ""
done
