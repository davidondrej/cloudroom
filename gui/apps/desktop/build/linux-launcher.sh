#!/bin/bash
# AppImage launcher (#75): the AppImage unmounts when this exits, and a Chromium helper still
# running from the mount then dies with SIGBUS. Run the app as a child, then kill leftovers first.
# Only from its own mount: extracted or unpacked copies share a folder with other instances.

self="$(readlink -f "$0")"
appdir="${self%/*}"
app="$self.bin"

mounted=0
while read -r _ _ _ _ point _; do
  [ "$point" = "${appdir// /\\040}" ] && mounted=1 && break
done < /proc/self/mountinfo

if [ -n "$ELECTRON_RUN_AS_NODE" ] || [ "$mounted" -eq 0 ]; then
  exec -a "$0" "$app" "$@"
fi

( trap - INT QUIT; exec -a "$0" "$app" "$@" ) &
pid=$!
for signal in TERM INT HUP QUIT; do
  trap "kill -$signal $pid 2>/dev/null" "$signal"
done

wait "$pid"
status=$?
while [ "$status" -gt 128 ]; do
  if kill -0 "$pid" 2>/dev/null; then
    wait "$pid"
    status=$?
  else
    wait "$pid" 2>/dev/null
    reaped=$?
    [ "$reaped" -ne 127 ] && status=$reaped
    break
  fi
done
trap - TERM INT HUP QUIT

for ((round = 0; round < 20; round++)); do
  left=()
  for proc in /proc/[0-9]*; do
    exe="$(readlink "$proc/exe" 2>/dev/null)" || continue
    [[ "$exe" == "$appdir"/* ]] && left+=("${proc#/proc/}")
  done
  [ "${#left[@]}" -eq 0 ] && break
  kill -KILL "${left[@]}" 2>/dev/null
  sleep 0.1
done

exit "$status"
