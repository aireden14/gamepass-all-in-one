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

# Bring the database schema up to date before anything serves traffic. Fly ran
# this as a release_command; Render has no equivalent hook, so it lives here.
#
# Deliberately no --accept-data-loss: on a destructive change `db push` fails
# instead of dropping columns, and we start anyway rather than bricking the
# container — the bots do not need Postgres, only the game backend does.
if [ -n "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] syncing Prisma schema…"
  if (cd /app/services/gamepass \
        && ./node_modules/.bin/prisma db push \
             --schema prisma/schema.prisma --skip-generate); then
    echo "[entrypoint] schema in sync"
  else
    echo "[entrypoint] WARNING: schema sync failed — starting services anyway"
  fi
else
  echo "[entrypoint] WARNING: DATABASE_URL unset — skipping schema sync"
fi

exec supervisord -c /etc/supervisor/supervisord.conf
