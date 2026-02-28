#!/bin/bash
# Log Watcher — monitors mini-agent server.log for errors and patterns
# Gives mushi something meaningful to analyze between Kuro's cycles.

MINI_DIR="/Users/user/Workspace/mini-agent"
INSTANCE_DIR="$HOME/.mini-agent/instances/f6616363"
LOG="$INSTANCE_DIR/logs/server.log"

if [ ! -f "$LOG" ]; then
  echo "Log: not found"
  exit 0
fi

echo "=== Mini-Agent Log Watch ==="

# Recent errors (last 50 lines)
ERRORS=$(tail -200 "$LOG" 2>/dev/null | grep -i "error\|fail\|timeout\|SIGTERM\|crash" | tail -5)
ERROR_COUNT=$(tail -200 "$LOG" 2>/dev/null | grep -ci "error\|fail\|timeout" 2>/dev/null || echo "0")

echo "Recent errors (last 200 lines): $ERROR_COUNT"
if [ -n "$ERRORS" ]; then
  echo "$ERRORS"
fi

# Last claude call
LAST_CLAUDE=$(tail -200 "$LOG" 2>/dev/null | grep "claude.call" | tail -1)
if [ -n "$LAST_CLAUDE" ]; then
  echo ""
  echo "Last Claude call: $LAST_CLAUDE"
fi

# Log file size and age
LOG_SIZE=$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')
LOG_LINES=$(wc -l < "$LOG" 2>/dev/null | tr -d ' ')
echo ""
echo "Log: ${LOG_SIZE} bytes, ${LOG_LINES} lines"
