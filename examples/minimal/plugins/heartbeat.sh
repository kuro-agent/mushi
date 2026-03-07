#!/bin/bash
# Heartbeat — basic system awareness
echo "Time: $(date '+%Y-%m-%d %H:%M %Z')"
echo "Host: $(hostname -s)"
echo "Load: $(uptime | sed 's/.*load average/load/')"
