# All-in-one image: GamePass backend (Node) + 3 Telegram bots (Python)
# behind a single nginx router, supervised by supervisord.
#
# Why one image: Render's free tier bills 750 instance-hours per WORKSPACE,
# so only one always-on service fits. Four services = one container.

# Node comes from its own official image rather than a piped install script:
# `curl … | bash` would execute freshly downloaded code as root on every
# build, with no pinning and no way to review what changed upstream.
FROM node:20-slim AS node

FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

# System deps:
#   nginx      — single-port router (Render exposes exactly one $PORT)
#   supervisor — keeps all four processes alive, restarts crashers
#   openssl    — required by Prisma engines on slim images
#   gettext-base — envsubst, to bake $PORT into nginx.conf at boot
#
# Deliberately NO apt ffmpeg: it drags in ~230 packages of mesa/X11/SDL for a
# container that never renders anything. The transcriber's get_ffmpeg_path()
# already falls back to the binary shipped by the imageio-ffmpeg wheel.
# Trade-off: that wheel has no ffprobe, so ensure_media_has_audio_stream()
# skips its pre-flight check — a video with no audio track now fails during
# conversion instead of being rejected up front.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates openssl \
        nginx supervisor gettext-base \
    && rm -rf /var/lib/apt/lists/* /var/log/* /usr/share/doc /usr/share/man

# Lift the Node runtime out of the official image: binary plus the bundled
# npm/npx in node_modules, then re-create the usual symlinks.
COPY --from=node /usr/local/bin/node            /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules    /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version

WORKDIR /app

# ---------------------------------------------------------------- Python bots
# Install all three requirement sets in one layer so shared deps (aiogram,
# aiohttp) are deduplicated instead of pulled three times.
COPY services/transcriber/requirements.txt  /tmp/req-transcriber.txt
COPY services/relay/requirements.txt        /tmp/req-relay.txt
RUN pip install --no-cache-dir \
        -r /tmp/req-transcriber.txt \
        -r /tmp/req-relay.txt \
    && rm -f /tmp/req-*.txt

# ------------------------------------------------------------ GamePass (Node)
# Deps first, so a source-only change does not re-run npm ci.
COPY services/gamepass/package*.json ./services/gamepass/
RUN cd services/gamepass && npm ci --no-audit --no-fund

COPY services/gamepass/ ./services/gamepass/
# No `npm prune --omit=dev` here: the Prisma CLI is a devDependency, and the
# entrypoint needs it at RUNTIME to sync the schema (Fly did this in its
# release_command; Render has no equivalent hook). Pruning would strip the CLI
# and leave a connected-but-empty database. Disk is not the constrained
# resource on this plan — the 512MB RAM cap is.
RUN cd services/gamepass \
    && npx prisma generate \
    && npm run build \
    && rm -rf src

# ------------------------------------------------------------- Bot sources
COPY services/transcriber/ ./services/transcriber/
COPY services/relay/       ./services/relay/

# ------------------------------------------------------------------- Runtime
COPY config/nginx.conf.template /etc/nginx/nginx.conf.template
COPY config/supervisord.conf    /etc/supervisor/supervisord.conf
COPY config/entrypoint.sh       /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /var/log/supervisor /data

# Render injects $PORT; Fly and local default to 8080.
ENV PORT=8080 \
    GAMEPASS_PORT=3001 \
    RELAY_PORT=8081 \
    TRANSCRIBER_PORT=8082

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
