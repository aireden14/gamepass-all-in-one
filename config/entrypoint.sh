#!/bin/sh
set -eu

# Render assigns $PORT at runtime and it is not knowable at build time, so the
# nginx config is a template rendered here.
#
# The explicit variable list matters: bare `envsubst` would also replace nginx's
# own runtime variables ($http_upgrade, $proxy_add_x_forwarded_for, $host, …)
# with empty strings and silently break proxying and WebSocket upgrades.
envsubst '${PORT} ${GAMEPASS_PORT} ${RELAY_PORT} ${TRANSCRIBER_PORT}' \
  < /etc/nginx/nginx.conf.template \
  > /etc/nginx/nginx.conf

# Fail loudly at boot rather than serving a half-broken router.
nginx -t

echo "[entrypoint] router on :${PORT} -> gamepass:${GAMEPASS_PORT} relay:${RELAY_PORT} transcriber:${TRANSCRIBER_PORT}"

exec supervisord -c /etc/supervisor/supervisord.conf
