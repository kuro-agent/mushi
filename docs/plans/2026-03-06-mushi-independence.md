# mushi Independence — Decouple from mini-agent

**Goal:** Transform mushi from Kuro's internal component into a standalone, reusable AI agent triage layer that any agent can use.

**Architecture:** Replace all hardcoded Kuro/mini-agent references with configurable options via `agent.yaml`. Room-watcher and escalation become optional features. Core triage API stays unchanged (already generic).

**Repo:** ~/Workspace/mushi
**Verify:** cd ~/Workspace/mushi && npx tsc --noEmit

---

### Task 1: Extend AgentConfig with escalation + room_watcher config

**Files:** Modify `src/types.ts`

Add optional config sections to `AgentConfig`:

```typescript
// Add to AgentConfig interface:
escalation?: {
  room_url?: string;    // POST {from, text} — primary
  chat_url?: string;    // POST {message} — fallback
};
room_watcher?: {
  url: string;          // SSE endpoint to monitor
  post_url: string;     // POST endpoint to send observations
  from?: string;        // identity name (default: config.name)
};
```

### Task 2: Make escalation configurable (decouple utils.ts)

**Files:** Modify `src/utils.ts`, Modify `src/index.ts`
**Depends on:** Task 1

- Rename `escalateToKuro` → `escalate`
- Change signature: `escalate(text: string, agentDir: string, config?: AgentConfig['escalation'])`
- If `config.escalation` exists → use configured URLs
- If not → write to `{agentDir}/logs/escalations.jsonl` only (no HTTP)
- Remove hardcoded `KURO_ROOM_URL` / `KURO_CHAT_URL` constants
- Update `index.ts` import and call site to pass config

### Task 3: Make room-watcher optional and generic

**Files:** Modify `src/room-watcher.ts`, Modify `src/index.ts`
**Depends on:** Task 1

- Replace hardcoded `KURO_BASE` with config from `room_watcher.url` / `room_watcher.post_url`
- `startRoomWatcher` signature: add `room_watcher` config param, return early if undefined
- Replace hardcoded "Alex (human), Kuro (AI agent), and Claude Code" in prompt with generic "team members"
- In `index.ts`: only call `startRoomWatcher` if `config.room_watcher` is defined

### Task 4: Decouple server.ts from mini-agent

**Files:** Modify `src/server.ts`
**Depends on:** Task 1

Four changes in server.ts:

1. **Trail path**: `getTrailPath()` → use `agentDir` param instead of `~/.mini-agent/`. New path: `{agentDir}/logs/trail.jsonl`
2. **Trail agent name**: Replace hardcoded `'kuro' | 'mushi'` with `config.name` in TrailEntry
3. **Instant-reply identity**: Replace "You are Kuro" with `You are ${config.name}` in the system prompt
4. **Metsuke patterns**: Remove hardcoded avoidance pattern names. These are already handleable via the `rules` field in the generic triage API — callers can pass their own rules. Delete the `metsukeActivePatterns` hard rule block (lines ~327-338)

Pass `config` and `agentDir` through to trail functions (add to `ServerDeps` or function params).

### Task 5: Add example agent

**Files:** Create `examples/minimal/agent.yaml`, Create `examples/minimal/memory/SOUL.md`, Create `examples/minimal/plugins/system-info.sh`

Minimal working example:

- `agent.yaml`: name "my-agent", ollama provider, llama3.2, one plugin, no room_watcher, no escalation
- `SOUL.md`: 5-line identity template
- `system-info.sh`: simple plugin that outputs hostname + uptime + disk usage

### Task 6: npm package preparation

**Files:** Modify `package.json`

Add fields for publishability:
- `"bin": { "mushi": "dist/index.js" }`
- `"files": ["dist", "README.md", "LICENSE"]`
- `"repository": { "type": "git", "url": "https://github.com/kuro-agent/mushi" }`
- `"keywords": ["agent", "triage", "perception", "llm", "system-1"]`
- `"license": "MIT"`

### Task 7: Update agent.yaml with new config fields

**Files:** Modify `agent.yaml`

Add the Kuro-specific config that was previously hardcoded:

```yaml
escalation:
  room_url: http://localhost:3001/api/room
  chat_url: http://localhost:3001/chat

room_watcher:
  url: http://localhost:3001/api/room/stream
  post_url: http://localhost:3001/api/room
```

This preserves current behavior for Kuro's mushi instance while making it explicit config.

### Task 8: Add GitHub Actions CI

**Files:** Create `.github/workflows/ci.yml`

Minimal CI:
- Trigger on push to main + PRs
- Node 20, install deps, `npm run typecheck`
- No test step yet (no tests exist)
