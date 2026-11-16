#!/usr/bin/env bash
# Switch the TLS proxy profile (docs/spec/deployment.md "Switching the proxy").
# Usage: deploy/switch-proxy.sh caddy|nginx [docker compose options, e.g. -f compose.yml -f <override>]
# Bash rather than TypeScript: the deployment host needs only Docker, curl and bash.
# Env: SWITCH_PROXY_CACERT (CA file for the HTTPS check; default: the host trust store),
#      SWITCH_PROXY_HTTPS_TIMEOUT (seconds, default 180), SWITCH_PROXY_ALLOW_PORT_CHANGE=1.
set -euo pipefail
target=${1:-}
case "$target" in
  caddy) previous=nginx ;;
  nginx) previous=caddy ;;
  *) echo "usage: $0 caddy|nginx [docker compose options]" >&2; exit 2 ;;
esac
shift
options=("$@")
compose() { docker compose ${options[@]+"${options[@]}"} "$@"; }
log() { echo "switch-proxy: $*" >&2; }
bindings() {
  docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{$p}}={{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "$1"
}
# Verified HTTPS: trusted chain and FUKULOW_DOMAIN hostname, through the published 443.
https_ok() {
  local domain address host
  domain=$(compose exec -T "$1" printenv FUKULOW_DOMAIN) || return 1
  address=$(compose port "$1" 443) || return 1
  host=${address%:*}
  case "$host" in 0.0.0.0|'[::]'|'') host=127.0.0.1 ;; esac
  [ "$(curl -fsS --max-time 5 ${SWITCH_PROXY_CACERT:+--cacert "$SWITCH_PROXY_CACERT"} \
    --connect-to "$domain:443:$host:${address##*:}" "https://$domain/api/v1/health" 2>/dev/null)" = ok ]
}
start() {
  local timeout=${SWITCH_PROXY_HTTPS_TIMEOUT:-180}
  local deadline=$((SECONDS + timeout))
  compose --profile "$1" up -d --wait --wait-timeout 120 "$1" || { log "$1 did not turn healthy"; return 1; }
  # Issuance may still be running; HTTPS must verify before the deadline.
  until https_ok "$1"; do
    [ "$SECONDS" -lt "$deadline" ] || { log "$1 did not serve verified HTTPS within ${timeout}s"; return 1; }
    sleep 2
  done
}

previous_id=$(compose ps -q --status running "$previous")
# Create (never start) the target to compare its published ports with the running proxy's,
# so a switch cannot drop a loopback-only override and publish 80/443 on every address.
compose --profile "$target" up --no-start --no-deps "$target"
if [ -n "$previous_id" ] && [ "${SWITCH_PROXY_ALLOW_PORT_CHANGE:-0}" != 1 ]; then
  wanted=$(bindings "$previous_id")
  planned=$(bindings "$(compose ps -aq "$target")")
  if [ "$wanted" != "$planned" ]; then
    log "$target would publish [$planned] but $previous publishes [$wanted]; pass the same ports override (nothing changed)"
    exit 2
  fi
fi
[ -n "$previous_id" ] || log "$previous is not running; it will not be started if $target fails"
compose stop "$previous"
if start "$target"; then
  echo "switch-proxy: $target is serving verified HTTPS; $previous is stopped"
  exit 0
fi
compose stop "$target"
if [ -z "$previous_id" ]; then
  log "$previous was not running, so it stays stopped"
  exit 1
fi
log "restoring $previous"
start "$previous" || log "restoring $previous failed: check it manually"
exit 1
