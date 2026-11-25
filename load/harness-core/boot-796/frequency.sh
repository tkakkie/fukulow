#!/usr/bin/env bash
# #796 frequency settings at boot, as root (load/harness-core/boot-796.ts, #996). Bash: no Node at boot.
set -euo pipefail
profile=performance
governor=performance
boost=0
max_khz=2000000
cpufreq=/sys/devices/system/cpu/cpufreq
# Write only a differing value: amd-pstate rejects a per-policy boost write while global boost is off.
set_value() { if [[ "$(<"$2")" != "$1" ]]; then printf '%s\n' "$1" > "$2"; fi; }
# Store the profile in power-profiles-daemon too, so it never re-applies a different saved one.
if command -v powerprofilesctl >/dev/null; then powerprofilesctl set "$profile"; fi
set_value "$profile" /sys/firmware/acpi/platform_profile
set_value "$boost" "$cpufreq/boost"
for policy in "$cpufreq"/policy*; do
  set_value "$governor" "$policy/scaling_governor"
  set_value "$boost" "$policy/boost"
  set_value "$max_khz" "$policy/scaling_max_freq"
done
