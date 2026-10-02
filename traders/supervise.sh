#!/bin/bash
# Persistent 24/7 supervisor for the copytrade paper bots.
# Runs the driver every 2 minutes. Paper money only.
cd ~/workspace/copytrade || exit 1
# Clean up our own stale lock on any trappable exit (SIGKILL/reboot still
# leaves it, but run.mjs now validates the lock PID and ignores dead owners).
trap 'rm -f trader-logs/run.lock' EXIT INT TERM HUP
echo "$(date -u +%FT%TZ) supervisor started (pid $$)" >> trader-logs/cron.log
while true; do
  timeout 600 node traders/run.mjs >> trader-logs/cron.log 2>&1
  # timeout 124 = the 600s cycle cap fired; loop continues regardless
  sleep 120
done
