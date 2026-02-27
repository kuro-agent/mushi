#!/bin/bash
# Inbox perception — checks for messages dropped into inbox/
# Communication interface: echo "hello" >> inbox/msg.txt

DIR="${AGENT_DIR:-.}"
INBOX="$DIR/inbox"

if [ ! -d "$INBOX" ]; then
  echo "(no inbox directory)"
  exit 0
fi

files=$(find "$INBOX" -type f -name "*.txt" -o -name "*.md" 2>/dev/null | sort)

if [ -z "$files" ]; then
  echo "(inbox empty)"
  exit 0
fi

count=$(echo "$files" | wc -l | tr -d ' ')
echo "=== $count message(s) ==="

echo "$files" | while read -r f; do
  name=$(basename "$f")
  content=$(head -20 "$f")
  echo "--- $name ---"
  echo "$content"
  echo ""
done
