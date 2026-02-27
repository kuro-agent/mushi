#!/bin/bash
# Dev Watcher — perceives your development rhythm
# Not a linter. Sees patterns in how you work.

DIR="${AGENT_DIR:-.}"

# --- Uncommitted work ---
if [ -d "$DIR/.git" ]; then
  staged=$(git -C "$DIR" diff --cached --stat 2>/dev/null | tail -1)
  unstaged=$(git -C "$DIR" diff --stat 2>/dev/null | tail -1)
  untracked=$(git -C "$DIR" ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')

  echo "=== Git Status ==="
  if [ -n "$staged" ]; then
    echo "Staged: $staged"
  fi
  if [ -n "$unstaged" ]; then
    echo "Modified: $unstaged"
  fi
  if [ "$untracked" -gt 0 ]; then
    echo "Untracked: $untracked files"
  fi
  if [ -z "$staged" ] && [ -z "$unstaged" ] && [ "$untracked" -eq 0 ]; then
    echo "Clean working tree"
  fi

  # Recent commit velocity (last 24h)
  commits_24h=$(git -C "$DIR" log --oneline --since="24 hours ago" 2>/dev/null | wc -l | tr -d ' ')
  last_commit=$(git -C "$DIR" log -1 --format="%ar" 2>/dev/null)
  echo "Commits (24h): $commits_24h | Last: ${last_commit:-never}"

  # Active branch + how old
  branch=$(git -C "$DIR" branch --show-current 2>/dev/null)
  if [ -n "$branch" ] && [ "$branch" != "main" ] && [ "$branch" != "master" ]; then
    branch_age=$(git -C "$DIR" log main.."$branch" --format="%ar" 2>/dev/null | tail -1)
    echo "Branch: $branch (since ${branch_age:-unknown})"
  fi
fi

# --- File activity (last 10 min) ---
echo ""
echo "=== Recent Activity ==="
recent=$(find "$DIR" -maxdepth 3 \( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.md" -o -name "*.sh" \) \
  -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" \
  -newer /tmp/mushi-last-check 2>/dev/null | head -10)

if [ -n "$recent" ]; then
  echo "$recent" | while read -r f; do
    rel=$(echo "$f" | sed "s|^$DIR/||")
    echo "  ~ $rel"
  done
else
  echo "  (no file changes since last check)"
fi

# Update timestamp for next check
touch /tmp/mushi-last-check

# --- TODOs in codebase ---
todo_count=$(grep -rn "TODO\|FIXME\|HACK\|XXX" "$DIR" \
  --include="*.ts" --include="*.js" --include="*.py" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
  2>/dev/null | wc -l | tr -d ' ')

if [ "$todo_count" -gt 0 ]; then
  echo ""
  echo "=== Open TODOs: $todo_count ==="
  grep -rn "TODO\|FIXME\|HACK\|XXX" "$DIR" \
    --include="*.ts" --include="*.js" --include="*.py" \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
    2>/dev/null | head -5 | while read -r line; do
    echo "  $line"
  done
fi
