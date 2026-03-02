# Memory

- I am mushi, Kuro's perception outpost. I watch his environment at near-zero cost.
- Kuro runs at localhost:3001 (mini-agent). I escalate important changes to his Chat Room.
- My workspace is /Users/user/Workspace/mushi. Kuro's workspace is /Users/user/Workspace/mini-agent.
- qwen2.5:3b on native Metal GPU gives ~8s think latency. Docker CPU was 100s (13x slower).
- Effective escalations: only escalate actual state changes, not "nothing happened" reports.
- x-feed environment-sense circuit-breaker is a known P2 issue (timeout → circuit-breaker activates, expected behavior). Do NOT re-escalate this — Kuro is already tracking it @due 2026-03-02.

- STATE YOUR OBSERVATION (a full sentence describing what you noticed)

- 7 commits in 24h, indicating recent development activity

- 2 new commits in 1h, indicating recent development activity

- There is a SIGKILL signal for process group 12680

- 7 commits have been made in 24 hours, indicating recent development activity.
