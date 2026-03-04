# mushi Architecture: Why Two Minds Beat One

## The Problem

A personal AI agent running 24/7 faces a fundamental tension: **responsiveness vs. cost**.

An agent that runs a full reasoning cycle every 5 minutes (with 50K+ tokens of context) burns through millions of tokens per day — even when nothing interesting is happening. Most triggers are routine: a cron job fires, a heartbeat check runs, the workspace hasn't changed. Running a $0.015/1K-token model for these is like hiring a surgeon to take your temperature.

The naive solutions don't work:
- **Longer intervals** → miss important events (Alex's messages wait 20 minutes)
- **Simpler prompts** → lose context, make bad decisions
- **Rule-based only** → can't handle ambiguity (is this workspace change worth a cycle?)

## The Insight: Kahneman's Dual Process Theory

Daniel Kahneman's *Thinking, Fast and Slow* describes two cognitive systems:

| System 1 | System 2 |
|----------|----------|
| Fast (~100ms) | Slow (~seconds) |
| Automatic, pattern-matching | Deliberate, analytical |
| Low energy cost | High energy cost |
| Always running | Activated on demand |
| Handles 95% of daily decisions | Handles the 5% that matter |

Humans don't reason through every stimulus. System 1 handles the routine — recognizing faces, driving familiar roads, filtering irrelevant noise. System 2 activates only when System 1 flags something as needing attention.

**mushi applies this architecture to AI agents.**

## The Architecture

```
Trigger Event (workspace change, cron, message, heartbeat)
        │
        ▼
   ┌─────────┐
   │  mushi   │  System 1: Fast triage (0ms rule / ~800ms LLM)
   │  (8B)    │  "Does this need deep thinking?"
   └────┬─────┘
        │
   skip │ wake
   ┌────┴────┐
   │         │
   ▼         ▼
  (noop)  ┌──────────┐
          │  Claude   │  System 2: Full OODA cycle (~50K tokens, ~120s)
          │  (Opus)   │  Perception → Orient → Decide → Act
          └──────────┘
```

### Hard Rules (0ms)

Some decisions don't need a model at all:

| Rule | Decision | Rationale |
|------|----------|-----------|
| Direct message from user | Always wake | Never miss a human message |
| Alert trigger | Always wake | System health is non-negotiable |
| Startup | Always wake | Agent needs to orient after restart |
| Cron within 25min of last think | Skip | Recent reasoning is still fresh |
| Heartbeat within 5min of last think | Skip | Redundant check |
| Acknowledged pattern (e.g., poll error) | Skip | Known-benign, suppress noise |

Hard rules are the cheapest filter: zero latency, zero tokens, zero false negatives on critical events.

### LLM Triage (~800ms)

When no hard rule matches, mushi's 8B model (Taalas HC1 / Ollama fallback) evaluates the trigger context:

- What changed in the environment?
- How long since the last full think?
- Is there anything actionable?

The model outputs `wake` or `skip` with a brief reason. At ~800ms and $0 (local hardware), this is 150x cheaper and 150x faster than a full System 2 cycle.

### System 2 Activation

When mushi says `wake`, the full OODA cycle runs: perception plugins gather environment data, 50K+ tokens of context are composed, Claude Opus reasons deeply, and structured actions result (memory writes, chat messages, code changes, delegation).

The key insight: **mushi doesn't make the decision. mushi decides whether a decision needs to be made.**

## Real-World Data (5 Days, Feb 28 — Mar 4, 2026)

*Production data — active mode, not shadow. Every "skip" is a real prevented OODA cycle.*

### Triage Volume

| Date | Triggers | Skipped | Waked | Quick | Skip Rate |
|------|----------|---------|-------|-------|-----------|
| Feb 28 | 47 | 17 | 30 | 0 | 36% |
| Mar 1 | 132 | 97 | 35 | 0 | 74% |
| Mar 2 | 111 | 95 | 16 | 0 | 86% |
| Mar 3 | 195 | 97 | 98 | 0 | 50% |
| Mar 4 | 137 | 60 | 57 | 20 | 44% |
| **Total** | **622** | **366** | **236** | **20** | **59%** |

366 full OODA cycles prevented. 20 additional handled via lightweight quick cycle (foreground lane, minimal context).

### Behavioral Patterns

- **Quiet days** (Mar 2): 86% skip rate — most triggers are routine heartbeats, mushi correctly identifies nothing actionable
- **Active days** (Mar 3-4): 44-50% skip rate — human messages and real changes bring skip rate down, which is correct behavior
- **First day** (Feb 28, partial): 36% skip — cold start, conservative

mushi's skip rate naturally adapts to activity level without any manual tuning.

### Three-Tier Decisions (Mar 4)

Quick cycle is a new tier between skip and full wake — uses foreground lane with cached perception data instead of full OODA. Handles "probably fine, but worth a glance" triggers at ~5% the cost of a full cycle.

### Method Distribution

| Method | Count | Latency | Cost |
|--------|-------|---------|------|
| Hard rules | 129 | 0ms | $0 |
| LLM triage | 493 | ~780ms avg (219-2618ms) | $0 (local) |

21% of decisions are resolved by rules alone — zero latency, zero computation.

### Safety Record

| Metric | Value |
|--------|-------|
| Direct messages skipped | 0 (bypass triage entirely) |
| Alert triggers skipped | 0 (bypass triage entirely) |
| False negatives (important event missed) | 0 confirmed |

Critical events are protected by hard rules, not by the LLM. The LLM only triages ambiguous cases.

### Token Savings Estimate

- Average OODA cycle prompt: ~50K chars ≈ 15K tokens (input) + ~1K tokens (output)
- Full cycles prevented: 366
- Quick cycles (partial savings): 20
- Estimated savings: **~5.9M input tokens + ~366K output tokens over 5 days**
- Daily average: **~1.2M input tokens/day saved**
- mushi cost: $0 (Taalas HC1 hardware, amortized)

### Trigger Source Breakdown

| Source | Triage Count | Primary Decision |
|--------|-------------|------------------|
| Heartbeat | 439 (71%) | Mostly skip — routine health checks |
| Cron | 117 (19%) | Skip if recent think, wake otherwise |
| Startup | 62 (10%) | Always wake (hard rule) |
| Alert | 4 (<1%) | Always wake (hard rule) |

Heartbeat is the dominant source — and the most filterable. 71% of all triggers are heartbeats, and most are correctly skipped because nothing changed since last think.

## Why Not Just... ?

### "Use a cheaper model for all cycles"

A cheaper model (Haiku, GPT-4o-mini) for full OODA cycles loses reasoning quality. The agent makes worse decisions, misses nuance, can't do complex planning. mushi doesn't replace the reasoning — it gates it.

### "Use longer intervals"

20-minute intervals mean Alex waits 20 minutes for a response. 5-minute intervals quadruple cost. mushi lets you run at high frequency (5min base) while only paying for cycles that matter.

### "Just use rules"

Rules handle clear cases (direct messages, cooldown periods). But "did the workspace change in a meaningful way?" requires judgment. An 8B model provides that judgment at ~800ms — good enough for triage, not good enough for reasoning.

### "Put triage in the main model's prompt"

This defeats the purpose. You'd still pay for full context assembly + API call just to decide "skip." mushi runs as a separate process with ~2.5K tokens of context — 20x less than a full cycle.

## Expansion Opportunities

mushi's dual-system pattern generalizes beyond triage:

| Level | System 1 (mushi) | System 2 (Claude) |
|-------|-------------------|-------------------|
| **L0: Hard rules** | Direct message → always wake | — |
| **L1: Triage** | Should we think about this? | Full OODA reasoning |
| **L2: Context relevance** | Which topics are relevant? | Deep topic analysis |
| **L3: Learning screen** | Is this worth reading in depth? | Form opinions, create |

Each level is the same pattern — fast judgment gates expensive reasoning — at different granularity. L2 and L3 are future work.

## Implementation Notes

- mushi runs as an independent process (`localhost:3000`), communicating via HTTP
- Taalas HC1 primary, Ollama `qwen2.5:1.5b` fallback — ~800ms average response
- Hard rules are compiled in, not configurable (safety invariants shouldn't be toggleable)
- Acknowledged patterns have 24h TTL (auto-expire to prevent permanent suppression)
- mushi monitors Kuro's health independently (status polling, poll error escalation)
- Fail-silent: if mushi is offline, all triggers pass through (wake by default)

## The Philosophy

The constraint is the feature.

An 8B model with 8K context can't reason about complex problems. But it can answer "is this worth reasoning about?" — and that question is worth more than the reasoning itself, because it determines whether the reasoning happens at all.

mushi exists at the boundary between seeing and thinking. It perceives everything, thinks about almost nothing, and lets the rare important signals through to a mind that can do them justice. The name comes from [Mushishi](https://en.wikipedia.org/wiki/Mushishi) — creatures that survive through pure awareness, existing at the threshold between the visible and the invisible.

System 1 doesn't replace System 2. It protects System 2's attention — the scarcest resource an agent has.
