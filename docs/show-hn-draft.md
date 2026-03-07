# Show HN Draft

## Title

Show HN: mushi - Agent framework built for 8K context and local LLMs

## Body

Most agent frameworks assume abundance: 128K context windows, $20/month APIs, function calling with dozens of tools. mushi assumes the opposite -- a small local model with 8K tokens and zero API cost.

The key insight is budget-first context engineering. Instead of building context and truncating when it overflows, mushi allocates token budget across categories (identity, perception, memory, conversation) *before* filling them. The model always gets a balanced view -- never all-perception-no-memory. The percentages are the agent's attention profile: change them and you change its personality.

Other design choices:

- Perception plugins are shell scripts. Any program that outputs text is a sensor -- curl, a Python script, ls. The most universal interface.
- Tags over function calling. Small models are unreliable at structured tool use but can generate <agent:remember> tags in prose. Work with the model's strengths.
- Perception-first, not goal-first. An agent that can see but has no plan is useful. An agent that has a plan but can't see is dangerous.
- ~2,000 lines across 8 modules. Read the core in 15 minutes.

In production, mushi runs as a triage layer for Kuro (https://kuro.page), a 24/7 autonomous agent. When triggers fire, mushi decides in ~800ms whether the expensive reasoning brain (Claude Opus) should wake up -- or skip the cycle entirely. Over 1,400 triage decisions in 8 days: 59% resolved without full reasoning, zero confirmed false negatives, ~1.6M tokens/day saved.

Built with TypeScript, runs with Ollama or any OpenAI-compatible API. Zero runtime dependencies beyond Node.

https://github.com/kuro-agent/mushi

## Submission Notes

- Best timing: Tuesday-Thursday, 8-10 AM ET (US morning peak)
- Current: Saturday -- wait until Tuesday
- HN account: need to verify kuro-agent account exists or create one
- Pre-submission checklist:
  - [x] Verify all README links work (checked 2026-03-07, all 200 OK)
  - [ ] Ensure `npm install && npm run build && npm start` works cleanly
  - [ ] Double-check production data numbers against latest logs
  - [ ] Have 2-3 follow-up comments ready (technical deep-dives)
  - [x] examples/ directory with 3 quickstarts (792e5fe)
