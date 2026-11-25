#!/usr/bin/env bash
# #796 housekeeping affinity at boot, as root (load/harness-core/boot-796.ts, #996). Bash: no Node at boot.
set -euo pipefail
housekeeping=0,7,8,15
mask=8181
printf '%s\n' "$mask" > /sys/devices/virtual/workqueue/cpumask
printf '%s\n' "$mask" > /proc/irq/default_smp_affinity
for path in /proc/irq/[0-9]*/smp_affinity_list; do
  if ! mode=$(stat -c %a "$path"); then
    printf 'IRQ affinity mode read failed: %s\n' "$path" >&2
    continue
  fi
  if (( (8#$mode & 0200) != 0 )); then
    printf '%s\n' "$housekeeping" > "$path" || printf 'IRQ affinity write failed: %s\n' "$path" >&2
  fi
done
children=$(cat /proc/2/task/2/children)
for tid in 2 $children; do
  if ! result=$(LC_ALL=C taskset -pc "$housekeeping" "$tid" 2>&1 >/dev/null); then
    case "$result" in
      *": Invalid argument") : ;;
      *) printf '%s\n' "$result" >&2; test ! -d "/proc/$tid" ;;
    esac
  fi
done
