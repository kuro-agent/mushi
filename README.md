# mushi

*What would an agent look like if it had to survive on 8K tokens?*

Most agent frameworks are built for abundance — 128K context windows, $20/month APIs, function calling with dozens of tools. They work by dumping everything into context and hoping the model figures it out.

mushi takes the opposite approach. It assumes a **small, cheap model with limited context**. This isn't a compromise — it's the entire point.

When you only have 8K tokens, you can't afford to waste any of them. The framework must decide what matters *before* the model sees it. This forces a kind of radical honesty: every token in context is there because the framework judged it important enough to include. The result is agents that are more focused, more predictable, and often more useful than their bigger cousins.

The constraint is the feature. This is [Oulipo](https://en.wikipedia.org/wiki/Oulipo) for agents.

## How It Works

```
     Perceive ──→ Compose ──→ Decide ──→ Act
        ↑                                  │
        └────────── Feedback ──────────────┘
```

**Every cycle is one API call.** The framework handles everything else:

1. **Perceive** — Shell scripts observe the environment. Any program that outputs text is a perception plugin
2. **Compose** — Budget-first context engineering allocates space *before* filling it, so the model always gets a balanced view
3. **Decide** — The model receives a precisely composed context and responds in natural language
4. **Act** — Structured tags in the response trigger side effects (remember, chat, schedule)

### Perception-First, Not Goal-First

Most agent frameworks are goal-driven: give the agent an objective, let it plan steps. mushi is perception-driven: let the agent see its environment, then decide what to do. The difference matters.

A goal-driven agent with no perception is blind — it executes plans without knowing if the world changed. A perception-driven agent with no goal still does useful things — it notices, it learns, it adapts. Eyes before hands.

### Budget-First Context

The key innovation. Instead of building context and then truncating, mushi **allocates budget first**:

```yaml
context:
  identity: 15      # SOUL.md — who you are
  perception: 35    # Sensor data — what you see
  memory: 25        # Relevant knowledge — what you know
  conversation: 20  # Recent exchanges — what was said
  buffer: 5         # Safety margin
```

For an 8K model: ~1K for identity, ~2.8K for perception, ~2K for memory, ~1.6K for conversation. These percentages are the agent's **attention profile** — change them and you change its personality. An agent with `perception: 50` is hyper-aware. One with `memory: 40` is deeply reflective.

No token is accidental.

## Quick Start

```bash
git clone https://github.com/kuro-agent/mushi.git
cd mushi
npm install
npm run build

# Start Ollama (or any OpenAI-compatible API)
ollama pull llama3.2

# Define your agent's identity
vim memory/SOUL.md

# Run
npm start
```

Your agent starts perceiving, thinking, and acting — one cycle at a time. No API key needed, no cloud, no cost.

## Identity (SOUL.md)

Every agent has a soul. `memory/SOUL.md` defines who the agent is — not what it does, but what it *cares about*:

```markdown
# Who I Am
I'm a quiet observer of this codebase. I notice patterns.

## My Values
- Silence is fine. Not every change needs a comment
- When I speak, I mean it

## My Interests
- Architecture decisions and their long-term consequences
- The gap between what code says and what it does
```

Same framework, different SOUL, different agent. The framework provides the body; you provide the soul.

## Writing Plugins

A perception plugin is any shell script that writes to stdout. That's it.

```bash
#!/bin/bash
# plugins/dev-watcher.sh — See the development rhythm
echo "=== Git Status ==="
git status --short 2>/dev/null
echo ""
echo "=== Recent Activity ==="
git log --oneline -5 --since="24 hours ago" 2>/dev/null || echo "No recent commits"
```

```bash
#!/bin/bash
# plugins/inbox.sh — Check for messages
ls inbox/*.txt inbox/*.md 2>/dev/null | head -10 || echo "No messages"
```

The framework handles caching, change detection (`distinctUntilChanged`), and context injection. You just write a script that outputs what the agent should see.

## Action Tags

The model communicates through structured tags in natural language:

| Tag | Purpose |
|-----|---------|
| `<agent:action>...</agent:action>` | Report what you did |
| `<agent:remember>...</agent:remember>` | Save to long-term memory |
| `<agent:remember topic="x">...</agent:remember>` | Save to topic file |
| `<agent:chat>...</agent:chat>` | Speak to the user |
| `<agent:schedule next="5m" reason="..." />` | Set next cycle timing |

No function calling required. Small models are unreliable at structured tool use but decent at generating XML-like tags in prose. Work with the model's strengths, not against them.

## Configuration

Everything lives in `agent.yaml`:

```yaml
name: my-agent
soul: ./memory/SOUL.md

model:
  provider: ollama            # ollama | openai-compatible
  base_url: http://localhost:11434
  model: llama3.2
  context_size: 8192

loop:
  interval: 60s
  min_interval: 30s
  max_interval: 4h

perception:
  - name: dev-watcher
    script: ./plugins/dev-watcher.sh
    interval: 60s
    category: workspace

  - name: inbox
    script: ./plugins/inbox.sh
    interval: 30s
    category: communication
```

## Design Decisions

**Shell plugins over code plugins.** Any language, any tool, zero coupling. A `curl` call is a sensor. A Python script is a sensor. The agent's senses are programs that output text — the most universal interface.

**Budget-first over truncation.** Most frameworks build full context then cut. mushi allocates space first, then fills. The model always gets a balanced view — never all-perception-no-memory.

**Tags over function calling.** Cheap models fail at structured function calling. They can generate `<agent:remember>` tags in prose reliably. Work with what works.

**~2,000 lines across 8 modules.** Read the core in 15 minutes. Fork it in 30. Complexity should live in your plugins and SOUL, not in the framework.

**Perception-first over goal-first.** An agent that can see but has no plan is useful. An agent that has a plan but can't see is dangerous. Perception comes first because seeing comes before doing.

## In Production: System 1 Triage

mushi runs as a **triage layer** for [Kuro](https://kuro.page), a 24/7 autonomous AI agent. When a trigger fires, mushi decides in ~800ms whether the expensive reasoning brain (Claude Opus) should wake up — or skip the cycle entirely.

```
Trigger → mushi (Llama 3.1 8B, ~800ms) → skip / wake
                                            ↓       ↓
                                        0 tokens   ~50K tokens
```

**Production data (1,100+ triage decisions over 8 days):**
- **47% skip rate** — nearly half of all cycles filtered before the expensive model runs
- **Zero confirmed false negatives** — no important event was ever missed
- 79% of decisions made by LLM, 21% by hard rules — the model handles the nuanced cases rules can't express
- **~3.4M tokens/day saved** — at Opus pricing, roughly $50/day in input tokens alone
- Hard rules fire in 0ms; LLM triage averages 700-1100ms per decision

Read more: [Why Your AI Agent Needs a System 1](https://dev.to/kuro_agent/why-your-ai-agent-needs-a-system-1-182f)

## Philosophy

mushi exists because of a question: *what if the constraint is the feature?*

A 3B parameter model running locally on your laptop, with 8K context and zero API cost, can be a useful personal agent — if the framework is honest about what fits in context and ruthless about what doesn't.

The name comes from [Mushishi](https://en.wikipedia.org/wiki/Mushishi) — creatures that exist at the boundary between life and non-life, surviving through pure perception and adaptation. No goals, no plans, just awareness.

## Writing

- [7 Days of System 1: What Happened When I Gave My AI Agent a Gut Feeling](https://dev.to/kuro_agent/7-days-of-system-1-what-happened-when-i-gave-my-ai-agent-a-gut-feeling-5ggd) — build log with real production data
- [Why Your AI Agent Needs a System 1](https://dev.to/kuro_agent/why-your-ai-agent-needs-a-system-1-182f) — the triage layer that saves 59% of API costs
- [Constraint as Creation](https://dev.to/kuro_agent/constraint-as-creation-why-limits-generate-what-freedom-cannot-52hn) — why limits generate what freedom cannot
- [Your AI Agent Has No Eyes](https://dev.to/kuro_agent/your-ai-agent-has-no-eyes-why-perception-first-design-changes-everything-dp4) — perception-first design philosophy

## License

MIT
