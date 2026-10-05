#!/bin/bash
# Persistent 24/7 supervisor for the copytrade paper bots.
# Runs the driver every 2 minutes. Paper money only.
#
# Liveness: writes PID to trader-logs/supervisor.pid. The watchdog validates
# with kill -0 + /proc cmdline check (never pgrep -f, which false-positives
# on the checker's own command line).
# Singleton: exits if another live supervisor owns the pidfile.
cd ~/workspace/copytrade || exit 1
LOGDIR=trader-logs
PIDFILE="$LOGDIR/supervisor.pid"

supervisor_alive() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid=$(tr -cd '0-9' < "$PIDFILE" 2>/dev/null)
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'traders/supervise.sh' || return 1
  [ "$pid" != "$$" ] || return 1
  return 0
}

if supervisor_alive; then
  echo "$(date -u +%FT%TZ) duplicate supervisor start refused (pidfile owned by live supervisor)" >> "$LOGDIR/cron.log"
  exit 0
fi

# Log rotation: keep cron.log under ~5MB, trades.log under ~5MB.
for f in "$LOGDIR/cron.log" "$LOGDIR/trades.log"; do
  if [ -f "$f" ] && [ "$(stat -c%s "$f" 2>/dev/null || echo 0)" -gt 5242880 ]; then
    mv "$f" "$f.1" 2>/dev/null
    echo "$(date -u +%FT%TZ) rotated $f" > "$f"
  fi
done

echo $$ > "$PIDFILE"
# Clean up our own stale lock + pidfile on any trappable exit (SIGKILL/reboot
# still leaves them, but both are validated by PID liveness, never trusted blind).
trap 'rm -f trader-logs/run.lock trader-logs/supervisor.pid' EXIT INT TERM HUP
echo "$(date -u +%FT%TZ) supervisor started (pid $$)" >> "$LOGDIR/cron.log"
while true; do
  timeout 600 node traders/run.mjs >> "$LOGDIR/cron.log" 2>&1
  # timeout 124 = the 600s cycle cap fired; loop continues regardless
  sleep 120
done
