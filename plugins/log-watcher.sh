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

# Recent errors — time-based (last 1 hour), not line-based
# Uses ISO timestamps in server.log to filter accurately
# Filter out mushi's own messages to prevent feedback loop
ONE_HOUR_AGO=$(date -u -v-1H '+%Y-%m-%d %H:%M' 2>/dev/null || date -u -d '1 hour ago' '+%Y-%m-%d %H:%M' 2>/dev/null)

if [ -n "$ONE_HOUR_AGO" ]; then
  # Extract lines with timestamps >= 1 hour ago, then filter for errors
  # server.log format: "2026-03-06 00:24:51 ..." (space-separated date time)
  RECENT_LINES=$(awk -v cutoff="$ONE_HOUR_AGO" '/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}/ { ts=substr($0,1,16); if (ts >= cutoff) print }' "$LOG" 2>/dev/null)
  ERRORS=$(echo "$RECENT_LINES" | grep -i "error\|fail\|timeout\|SIGTERM\|crash" | grep -vi "\[ROOM\].*mushi\|mushi:\|escalat" | tail -5)
  ERROR_COUNT=$(echo "$RECENT_LINES" | grep -i "error\|fail\|timeout" | grep -vi "\[ROOM\].*mushi\|mushi:\|escalat" | wc -l | tr -d ' ')
else
  # Fallback: line-based if date command unavailable
  ERRORS=$(tail -200 "$LOG" 2>/dev/null | grep -i "error\|fail\|timeout\|SIGTERM\|crash" | grep -vi "\[ROOM\].*mushi\|mushi:\|escalat" | tail -5)
  ERROR_COUNT=$(tail -200 "$LOG" 2>/dev/null | grep -i "error\|fail\|timeout" | grep -vi "\[ROOM\].*mushi\|mushi:\|escalat" | wc -l | tr -d ' ')
fi

echo "Recent errors (last 1h): $ERROR_COUNT"
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
