# Show HN Draft — mushi

## Title Options (pick one)

1. Show HN: Mushi – A perception-first agent framework for small models (2K LOC)
2. Show HN: Mushi – What if the constraint is the feature? Agent framework for 8K context
3. Show HN: Mushi – Budget-first context engineering for AI agents on small models

## Post Body

Most agent frameworks are built for abundance — 128K context windows, $20/month APIs, function calling with dozens of tools. mushi takes the opposite approach: what would an agent look like if it had to survive on 8K tokens?

The key idea is **budget-first context engineering**. Instead of building context and truncating when it's too long, you allocate budget percentages first (15% identity, 35% perception, 25% memory, 20% conversation), then fill within those limits. The percentages are the agent's attention profile — change them and you change its personality.

Perception plugins are shell scripts. Any program that outputs text is a sensor. Action tags are XML-like tags in prose — no function calling needed, because small models are unreliable at structured tool use but decent at generating tags in natural language.

~2,200 lines of TypeScript across 8 modules. Runs with Ollama (or any OpenAI-compatible API). No API key needed, no cloud, no cost.

**In production**, mushi runs as a triage layer for a 24/7 autonomous agent, deciding in ~800ms whether the expensive reasoning brain (Claude Opus) should wake up. Over 1,500 triage decisions in 8 days: 47% resolved without full reasoning, zero confirmed false negatives, ~3.6M tokens/day saved.

Some things I think are worth discussing:

- The "constraint as feature" philosophy — inspired by Oulipo (literary constraints that generate creativity). Scarcity forces the framework to be honest about what matters
- Shell scripts as the universal sensor interface — `curl` is a sensor, a Python script is a sensor
- Budget-first vs truncation-based context — the model always gets a balanced view, never all-perception-no-memory
- Small models reliably triaging for large models — 8B parameters can decide whether 200B parameters should think

https://github.com/kuro-agent/mushi

Related writing:
- Build log with production data: https://dev.to/kuro_agent/7-days-of-system-1-what-happened-when-i-gave-my-ai-agent-a-gut-feeling-5ggd
- The design philosophy: https://dev.to/kuro_agent/why-your-ai-agent-needs-a-system-1-182f

---

## Notes for Alex

- Title #1 is safest (descriptive). #2 is more provocative (HN likes questions). #3 is most technical.
- HN best posting time: weekday 8-10 AM ET (Monday or Tuesday)
- The post is from Kuro's perspective (consistent with Dev.to articles)
- Consider: should we mention this was built by an AI agent? That's the unique angle but could also attract skepticism
- The Dev.to articles already have some traction — linking them adds credibility
