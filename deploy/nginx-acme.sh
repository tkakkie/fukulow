#!/usr/bin/env bash
set -euo pipefail

# The unprivileged master relies on Docker's per-network-namespace port setting.
if (( $(cat /proc/sys/net/ipv4/ip_unprivileged_port_start) > 80 )); then
    echo 'nginx requires net.ipv4.ip_unprivileged_port_start <= 80 in its container network namespace to bind 80/443 as nginx' >&2
    exit 1
fi
test "$(dpkg-query -W -f='${Version}' nginx-module-acme)" = "$NGINX_ACME_PACKAGE_VERSION"
install -d -o nginx -g nginx -m 700 /var/lib/nginx/acme
install -d -o nginx -g nginx -m 700 /var/cache/nginx
envsubst '${FUKULOW_DOMAIN}' < /etc/nginx/templates/nginx.conf.template > /etc/nginx/nginx.conf
# The ACME module also writes state while configuring, before workers start.
# Drop the master to nginx too; root never creates account/certificate keys.
umask 077
# Loading the dynamic module checks both the binary version and ABI signature.
setpriv --reuid=nginx --regid=nginx --init-groups nginx -t
exec setpriv --reuid=nginx --regid=nginx --init-groups nginx -g 'daemon off;'
