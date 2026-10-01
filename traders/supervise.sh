#!/bin/bash
# Persistent 24/7 supervisor for the copytrade paper bots.
# Runs the driver every 2 minutes. Paper money only.
cd ~/workspace/copytrade || exit 1
echo "$(date -u +%FT%TZ) supervisor started (pid $$)" >> trader-logs/cron.log
while true; do
  node traders/run.mjs >> trader-logs/cron.log 2>&1
  sleep 120
done
