#!/bin/bash
# Weather — current conditions via wttr.in (no API key needed)
curl -sf --max-time 5 "wttr.in/?format=%c+%t+%h+%w" 2>/dev/null || echo "(weather unavailable)"
