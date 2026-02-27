#!/bin/bash
# Inbox perception — checks for messages
# Drop a .txt/.md into inbox/, or POST to /api/inbox (writes .json)

DIR="${AGENT_DIR:-.}"
INBOX="$DIR/inbox"

if [ ! -d "$INBOX" ]; then
  echo "(no inbox directory)"
  exit 0
fi

files=$(find "$INBOX" -type f \( -name "*.txt" -o -name "*.md" -o -name "*.json" \) 2>/dev/null | sort)

if [ -z "$files" ]; then
  echo "(inbox empty)"
  exit 0
fi

count=$(echo "$files" | wc -l | tr -d ' ')
echo "=== $count message(s) ==="

echo "$files" | while read -r f; do
  name=$(basename "$f")

  if [[ "$f" == *.json ]]; then
    # JSON messages from HTTP API — extract with node (already a dependency)
    node -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log('--- ['+m.from+'] '+m.ts+' ---'); console.log(m.text)" "$f" 2>/dev/null || cat "$f"
  else
    # Plain text messages
    echo "--- $name ---"
    head -20 "$f"
  fi
  echo ""
done
