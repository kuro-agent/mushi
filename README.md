# kuro-agent

A perception-first agent framework for any LLM. Smaller models, tighter constraints, better behavior.

## Thesis

Most agent frameworks assume a powerful model with a large context window. kuro-agent assumes the opposite: **a cheap, small model with limited context**. This constraint isn't a problem — it's the design.

Smaller context windows force radical prioritization. The framework decides what the model needs to see, not the model. This produces agents that are more structured, more predictable, and more useful than "dump everything into 128K tokens and hope."

This is [Oulipo](https://en.wikipedia.org/wiki/Oulipo) for agents: voluntary constraints that generate capability.

## Quick Start

```bash
# Clone and install
git clone https://github.com/kuro-agent/kuro-agent.git
cd kuro-agent
npm install

# Start Ollama (or any OpenAI-compatible API)
ollama pull llama3.2

# Edit your agent's identity
vim memory/SOUL.md

# Run
npm start
```

Your agent will start perceiving its environment, composing context within budget, and deciding what to do — one cycle at a time.

## How It Works

```
     Perceive ──→ Compose ──→ Decide ──→ Act
        ↑                                  │
        └────────── Feedback ──────────────┘
```

**Every cycle is one API call.** The framework handles everything else:

1. **Perceive** — Shell plugins observe the environment (filesystem, time, inbox, anything)
2. **Compose** — Budget-first context engineering fits identity + perception + memory + conversation into the model's context window
3. **Decide** — The model receives a precisely composed context and responds
4. **Act** — Structured tags in the response trigger side effects (log, remember, chat, schedule)

### Budget-First Context

The key innovation. Instead of generating context and then truncating, kuro-agent **allocates budget first**:

```yaml
context:
  identity: 15      # SOUL.md — who you are
  perception: 35    # Sensor data — what you see
  memory: 25        # Relevant knowledge — what you know
  conversation: 20  # Recent exchanges — what was said
  buffer: 5         # Safety margin
```

For an 8K-token model: ~1K identity, ~2.8K perception, ~2K memory, ~1.6K conversation. Every token is intentional.

## Configuration

Everything in `agent.yaml`:

```yaml
name: my-agent
soul: ./memory/SOUL.md

model:
  provider: ollama            # ollama | openai-compatible
  base_url: http://localhost:11434
  model: llama3.2
  context_size: 8192

loop:
  interval: 60s               # default cycle interval
  min_interval: 30s
  max_interval: 4h

perception:
  - name: filesystem
    script: ./plugins/fs-watch.sh
    interval: 60s
    category: workspace

  - name: clock
    script: ./plugins/clock.sh
    interval: 300s
    category: system

memory:
  dir: ./memory
```

## Writing Plugins

A perception plugin is a shell script that outputs text to stdout. That's it.

```bash
#!/bin/bash
# plugins/weather.sh — What's the weather?
curl -sf "wttr.in/?format=3" 2>/dev/null || echo "Weather unavailable"
```

```bash
#!/bin/bash
# plugins/inbox.sh — Check for new messages
COUNT=$(find ~/inbox -type f -newer /tmp/.last-check 2>/dev/null | wc -l)
echo "Unread: $COUNT"
[ "$COUNT" -gt 0 ] && find ~/inbox -type f -newer /tmp/.last-check -exec basename {} \;
touch /tmp/.last-check
```

The framework handles caching, change detection, and context injection. You just write a script that outputs what the agent should see.

## Identity (SOUL.md)

Each agent has a `SOUL.md` that defines who it is:

```markdown
# Who I Am
I'm a development assistant that watches your codebase.

## My Values
- Never push to main without tests passing
- Flag security issues immediately

## My Interests
- Clean architecture
- Testing patterns

## My Style
- Direct and concise
- Code examples over explanations
```

Same framework + different SOUL = different agent. The framework provides the body; you provide the soul.

## Action Tags

The model communicates through structured tags:

| Tag | Purpose |
|-----|---------|
| `<agent:action>...</agent:action>` | Report what you did |
| `<agent:remember>...</agent:remember>` | Save to memory |
| `<agent:remember topic="x">...</agent:remember>` | Save to topic file |
| `<agent:chat>...</agent:chat>` | Speak to the user |
| `<agent:schedule next="5m" reason="..." />` | Set next cycle interval |

## Architecture Decisions

**Shell plugins over code plugins.** Any language, any tool, zero coupling. A `curl` call is a perception plugin. A Python script is a perception plugin. The agent's "senses" are just programs that output text.

**Budget-first over truncation.** Most frameworks build full context then cut. kuro-agent allocates space first, then fills. This means the model always gets a balanced view — never all-perception-no-memory or all-conversation-no-identity.

**Tags over function calling.** Small models are bad at structured function calling. They're decent at generating XML-like tags in natural language. The tag system works with any model that can follow simple formatting instructions.

**One file, ~500 lines.** The entire framework is `src/index.ts`. Read it in 10 minutes. Modify it in 20. This is intentional — complexity should live in your plugins and SOUL, not in the framework.

## Philosophy

kuro-agent exists because of a simple observation: **the best agents aren't the ones with the most tokens — they're the ones that use their tokens best.**

A perception-first agent with 8K context and a $0 local model can be more useful than a goal-driven agent with 128K context and a $20/month API — if the framework is smart about what goes into that context window.

The constraint is the feature.

## License

MIT
