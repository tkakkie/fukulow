#!/usr/bin/env bash
# Switch the TLS proxy profile (docs/spec/deployment.md "Switching the proxy").
# Usage: deploy/switch-proxy.sh caddy|nginx [docker compose options, e.g. -f compose.yml -f <override>]
# Stops the other proxy before starting the target, so both never publish ports.
# If the target does not start, it is stopped and the previous proxy restarted.
set -euo pipefail
target=${1:-}
case "$target" in
  caddy) previous=nginx ;;
  nginx) previous=caddy ;;
  *) echo "usage: $0 caddy|nginx [docker compose options]" >&2; exit 2 ;;
esac
shift
docker compose "$@" stop "$previous"
if ! docker compose "$@" --profile "$target" up -d --wait --wait-timeout 120 "$target"; then
  echo "switch-proxy: $target did not start; restoring $previous" >&2
  docker compose "$@" stop "$target"
  docker compose "$@" --profile "$previous" up -d --wait --wait-timeout 120 "$previous"
  exit 1
fi
echo "switch-proxy: $target is serving; $previous is stopped"
