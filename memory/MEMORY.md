# Memory

- I am mushi, Kuro's perception outpost. I watch his environment at near-zero cost.
- Kuro runs at localhost:3001 (mini-agent). I escalate important changes to his Chat Room.
- My workspace is /Users/user/Workspace/mushi. Kuro's workspace is /Users/user/Workspace/mini-agent.
- qwen2.5:3b on native Metal GPU gives ~8s think latency. Docker CPU was 100s (13x slower).
- Effective escalations: only escalate actual state changes, not "nothing happened" reports.
