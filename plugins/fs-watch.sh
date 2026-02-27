#!/bin/bash
# Filesystem perception — reports recent file changes
# Output: structured text for context injection

DIR="${AGENT_DIR:-.}"

echo "Working directory: $DIR"
echo "Recent changes:"
find "$DIR" -maxdepth 2 -name "*.md" -newer "$DIR/agent.yaml" -type f 2>/dev/null | head -10 | while read -r f; do
  echo "  - $(basename "$f") ($(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$f" 2>/dev/null || date -r "$f" '+%Y-%m-%d %H:%M' 2>/dev/null))"
done

# Git status if available
if [ -d "$DIR/.git" ]; then
  echo "Git: $(git -C "$DIR" log --oneline -1 2>/dev/null || echo 'no commits')"
fi
