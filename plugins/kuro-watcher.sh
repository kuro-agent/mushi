#!/bin/bash
# Kuro Watcher — monitors mini-agent health and workspace
# mushi's role: perception outpost. Detect what Kuro can't see between cycles.

KURO_URL="http://localhost:3001"
MINI_DIR="/Users/user/Workspace/mini-agent"

# --- Kuro Health ---
echo "=== Kuro Health ==="
# Retry up to 3 times — but keep total time under 30s polling interval.
# Worst case: 3 × 5s + 2 × 1s = 17s (well within 30s).
health=""
for attempt in 1 2 3; do
  health=$(curl -sf "$KURO_URL/health" --connect-timeout 2 --max-time 5 2>/dev/null)
  [ -n "$health" ] && break
  [ "$attempt" -lt 3 ] && sleep 1
done
if [ -z "$health" ]; then
  echo "STATUS: OFFLINE"
  echo "mini-agent not responding at $KURO_URL (3 attempts failed)"
else
  echo "STATUS: online"
  node -e "
    const d = JSON.parse(process.argv[1]);
    console.log('Instance: ' + (d.instance || '?'));
  " "$health" 2>/dev/null
fi

# --- Kuro Loop Status ---
status=$(curl -sf "$KURO_URL/status" --connect-timeout 2 --max-time 5 2>/dev/null)
if [ -n "$status" ]; then
  node -e "
    const d = JSON.parse(process.argv[1]);
    const loop = d.loop || {};
    const claude = d.claude || {};
    console.log('Loop: ' + (loop.running ? 'running' : 'stopped') + ' (' + (loop.mode || '?') + ')');
    console.log('Claude busy: ' + (claude.busy || false));
    if (claude.loop?.task) {
      const elapsed = claude.loop.task.elapsed || 0;
      console.log('Active task: ' + elapsed + 's');
    }
  " "$status" 2>/dev/null
fi

# --- Mini-Agent Workspace ---
if [ -d "$MINI_DIR/.git" ]; then
  echo ""
  echo "=== Mini-Agent Workspace ==="
  last_commit=$(LANG=C git -C "$MINI_DIR" log -1 --format="%h %s" 2>/dev/null)
  commits_1h=$(git -C "$MINI_DIR" log --oneline --since="1 hour ago" 2>/dev/null | wc -l | tr -d ' ')
  echo "Head: $last_commit"
  echo "Commits (1h): $commits_1h"

  # Uncommitted src/ changes (signal for active development)
  src_changes=$(git -C "$MINI_DIR" diff --name-only -- 'src/' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$src_changes" -gt 0 ]; then
    echo "Uncommitted src/ files: $src_changes"
  fi

  # Check for deploy activity
  deploy_recent=$(git -C "$MINI_DIR" log --oneline --since="10 minutes ago" -- '.github/' 'scripts/deploy.sh' 2>/dev/null | head -1)
  if [ -n "$deploy_recent" ]; then
    echo "Recent deploy: $deploy_recent"
  fi
fi
