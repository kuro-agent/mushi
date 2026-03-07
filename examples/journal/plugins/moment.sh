#!/bin/bash
# Moment — time awareness with context
hour=$(date '+%H')
day=$(date '+%A')
date_str=$(date '+%Y-%m-%d %H:%M')

echo "Now: $date_str ($day)"

if [ "$hour" -lt 6 ]; then echo "Period: deep night"
elif [ "$hour" -lt 9 ]; then echo "Period: early morning"
elif [ "$hour" -lt 12 ]; then echo "Period: morning"
elif [ "$hour" -lt 14 ]; then echo "Period: midday"
elif [ "$hour" -lt 17 ]; then echo "Period: afternoon"
elif [ "$hour" -lt 20 ]; then echo "Period: evening"
elif [ "$hour" -lt 23 ]; then echo "Period: night"
else echo "Period: late night"
fi
