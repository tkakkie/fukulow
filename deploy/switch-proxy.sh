#!/usr/bin/env bash
# Switch the TLS proxy profile (docs/spec/deployment.md "Switching the proxy").
# Usage: deploy/switch-proxy.sh caddy|nginx|none [docker compose options, e.g. -f compose.yml -f <override>]
# Set COMPOSE_PROFILES in .env to the target first: it is the one proxy setting.
# Bash rather than TypeScript: the deployment host needs only Docker, curl and bash.
# Env: SWITCH_PROXY_CACERT (CA file for the HTTPS check; default: the host trust store),
#      SWITCH_PROXY_HTTPS_TIMEOUT (seconds, default 180), SWITCH_PROXY_ALLOW_PORT_CHANGE=1,
#      none only: SWITCH_PROXY_URL (https://<domain> served by your own proxy, required),
#      SWITCH_PROXY_CONNECT_TO (host:port to reach it instead of DNS, optional).
set -euo pipefail
target=${1:-}
case "$target" in
  caddy|nginx|none) ;;
  *) echo "usage: $0 caddy|nginx|none [docker compose options]" >&2; exit 2 ;;
esac
shift
external_options=("$@")
options=()
external_overlay=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    -f|--file)
      case "${2:-}" in
        compose.external-proxy.yml|*/compose.external-proxy.yml) external_overlay=true; shift 2; continue ;;
      esac ;;
    -f=compose.external-proxy.yml|--file=compose.external-proxy.yml|-f=*/compose.external-proxy.yml|--file=*/compose.external-proxy.yml)
      external_overlay=true; shift; continue ;;
  esac
  options+=("$1")
  shift
done
compose() { docker compose ${options[@]+"${options[@]}"} "$@"; }
compose_external() { docker compose ${external_options[@]+"${external_options[@]}"} "$@"; }
log() { echo "switch-proxy: $*" >&2; }
bindings() {
  docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{$p}}={{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "$1"
}
# Verified HTTPS (trusted chain, hostname) of $1/api/v1/health, connecting to $2 (host:port) if set.
verified() {
  [ "$(curl -fsS --max-time 5 ${SWITCH_PROXY_CACERT:+--cacert "$SWITCH_PROXY_CACERT"} \
    ${2:+--connect-to "::$2"} "$1/api/v1/health" 2>/dev/null)" = ok ]
}
# A bundled proxy is checked for its FUKULOW_DOMAIN through its published 443.
https_ok() {
  local domain address host
  if [ "$1" = none ]; then verified "$SWITCH_PROXY_URL" "${SWITCH_PROXY_CONNECT_TO:-}"; return; fi
  domain=$(compose --profile "$1" exec -T "$1" printenv FUKULOW_DOMAIN) || return 1
  address=$(compose --profile "$1" port "$1" 443) || return 1
  host=${address%:*}
  case "$host" in 0.0.0.0|'[::]'|'') host=127.0.0.1 ;; esac
  verified "https://$domain" "$host:${address##*:}"
}
start() {
  local timeout=${SWITCH_PROXY_HTTPS_TIMEOUT:-180}
  local deadline=$((SECONDS + timeout))
  if [ "$1" != none ]; then
    compose --profile "$1" up -d --wait --wait-timeout 120 "$1" || { log "$1 did not turn healthy"; return 1; }
  elif "$external_overlay"; then
    compose_external up -d --wait --wait-timeout 120 app || { log "none app did not turn healthy"; return 1; }
  fi
  # Issuance may still be running; HTTPS must verify before the deadline.
  until https_ok "$1"; do
    [ "$SECONDS" -lt "$deadline" ] || { log "$1 did not serve verified HTTPS within ${timeout}s"; return 1; }
    sleep 2
  done
}

if [ "$target" = none ]; then
  case "${SWITCH_PROXY_URL:-}" in
    https://?*) SWITCH_PROXY_URL=${SWITCH_PROXY_URL%/} ;;
    *) log "none needs SWITCH_PROXY_URL=https://<domain> served by your own proxy (nothing changed)"; exit 2 ;;
  esac
fi
# The active profiles (COMPOSE_PROFILES or --profile) must select exactly the target, so a
# later plain `docker compose up -d` never starts the previous proxy again.
active=$(compose config --services)
selected=""
for proxy in caddy nginx; do
  if printf '%s\n' "$active" | grep -qx "$proxy"; then selected="$selected $proxy"; fi
done
expected=" $target"
[ "$target" != none ] || expected=""
if [ "$selected" != "$expected" ]; then
  log "the active profiles select [${selected# }]; set COMPOSE_PROFILES=$target in .env (nothing changed)"
  exit 2
fi
if [ "$target" = none ] && "$external_overlay"; then
  external_services=$(compose_external config --services)
  if ! printf '%s\n' "$external_services" | grep -qx app; then
    log "the external-proxy overlay needs COMPOSE_PROFILES=none (nothing changed)"
    exit 2
  fi
fi
others=""
for proxy in caddy nginx; do [ "$proxy" = "$target" ] || others="$others $proxy"; done
previous=""
previous_id=""
for proxy in $others; do
  id=$(compose --profile "$proxy" ps -q --status running "$proxy")
  if [ -n "$id" ]; then previous=$proxy; previous_id=$id; fi
done
if [ "$target" != none ]; then
  # Create (never start) the target to compare its published ports with the running proxy's,
  # so a switch cannot drop a loopback-only override and publish 80/443 on every address.
  compose --profile "$target" up --no-start --no-deps "$target"
  if [ -n "$previous_id" ] && [ "${SWITCH_PROXY_ALLOW_PORT_CHANGE:-0}" != 1 ]; then
    wanted=$(bindings "$previous_id")
    planned=$(bindings "$(compose --profile "$target" ps -aq "$target")")
    if [ "$wanted" != "$planned" ]; then
      log "$target would publish [$planned] but $previous publishes [$wanted]; pass the same ports override (nothing changed)"
      exit 2
    fi
  fi
fi
[ -n "$previous_id" ] || log "no other proxy is running; none will be started if $target fails"
# Stop every other bundled proxy, so none keeps running or holding 80/443. Every command naming a
# proxy passes its --profile: older Compose rejects a named service whose profile is not active.
for proxy in $others; do compose --profile "$proxy" stop "$proxy"; done
if start "$target"; then
  if [ "$target" = none ]; then
    echo "switch-proxy: none: $SWITCH_PROXY_URL serves verified HTTPS; no bundled proxy runs"
  else
    echo "switch-proxy: $target is serving verified HTTPS; ${previous:-no other proxy} is stopped"
  fi
  exit 0
fi
[ "$target" = none ] || compose --profile "$target" stop "$target"
if [ -z "$previous_id" ]; then
  log "no other proxy was running, so none is started"
  exit 1
fi
log "restoring $previous; set COMPOSE_PROFILES=$previous in .env again"
start "$previous" || log "restoring $previous failed: check it manually"
exit 1
