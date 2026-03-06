# mushi Independence Phase 1: API Standardization

## Goal
Make mushi's triage API usable by any AI agent, not just mini-agent.

## Problem
Current `/api/triage` is tightly coupled to mini-agent:
- Hard rules reference `DIRECT_MESSAGE_SOURCES` (telegram/room/chat) — other agents have different sources
- Metsuke avoidance patterns are mini-agent specific
- `metadata` schema assumes mini-agent fields (lastThinkAgo, perceptionChangedCount, etc.)
- Trail entries write to `~/.mini-agent/` path

## Tasks

### Task 1: Generic Triage Interface
**Verify:** `curl -s localhost:3000/api/triage -d '{"event":"timer","context":{"idle_seconds":300}}' | jq .action`

Current input:
```json
{"trigger": "heartbeat", "source": "...", "metadata": {"lastThinkAgo": 300, ...}}
```

Target input (backwards compatible):
```json
{
  "event": "timer|message|change|alert|custom",
  "priority_hint": "high|normal|low",
  "context": {
    "idle_seconds": 300,
    "changes_count": 2,
    "message_text": "..."
  },
  "rules": [
    {"match": {"event": "alert"}, "action": "wake"},
    {"match": {"event": "timer", "idle_seconds": "<300"}, "action": "skip"}
  ]
}
```

- Keep existing `trigger/source/metadata` format working (backwards compat)
- Add new `event/context/rules` format as primary
- Hard rules become configurable via `rules` array or `agent.yaml`

### Task 2: Configurable Rules Engine
**Verify:** `grep -c 'loadRules\|applyRules' src/server.ts`

- Extract hard rules from server.ts into a rules engine
- Default rules ship with mushi (current behavior)
- Users can override/extend via `agent.yaml` `rules:` section
- Rule format: `{match: conditions, action: wake|skip|quick, reason: string}`

### Task 3: Decouple Trail from mini-agent
**Verify:** `grep -c 'mini-agent' src/server.ts` should be 0

- Trail path configurable (default: `~/.mushi/trail.jsonl`)
- Remove hardcoded `~/.mini-agent/` references
- mini-agent integration becomes a config option, not a default

### Task 4: npm Package Structure
**Verify:** `node -e "const m = require('./dist/index.js'); console.log(typeof m.startServer)"`

- Export public API from index.ts
- Add bin entry for `npx mushi`
- package.json metadata (description, keywords, repository)
- Minimal README for npm

## Order
Task 1 → Task 2 (depends on interface) → Task 3 (independent) → Task 4 (final)

## Repo
~/Workspace/mushi
