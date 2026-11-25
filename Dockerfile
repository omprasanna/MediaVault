# syntax=docker/dockerfile:1

FROM node:22-alpine AS client-builder
WORKDIR /build/client
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache libc6-compat
COPY client/package*.json ./
RUN npm install --no-audit --no-fund \
      --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 \
    && npm cache clean --force
ARG INTERNAL_API_URL=http://127.0.0.1:5000
ENV INTERNAL_API_URL=${INTERNAL_API_URL}
ENV NODE_ENV=production
COPY client/ .
RUN npm run build

FROM node:22-alpine AS server-deps
WORKDIR /build/server
COPY server/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund \
      --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 \
    && npm cache clean --force \
    && find /build/server/node_modules -type f \( \
      -name "*.md" -o -name "*.markdown" -o -name "*.map" -o -name "*.d.ts" \
      -o -name "LICENSE*" -o -name "CHANGELOG*" \
    \) -delete

FROM alpine:3.24 AS ytdlp-builder
RUN apk add --no-cache python3 py3-pip gcc musl-dev libffi-dev python3-dev \
    && python3 -m venv /opt/ytdlp-venv \
    && ok=0; for attempt in 1 2 3 4 5; do \
         /opt/ytdlp-venv/bin/pip install --default-timeout=45 --retries 5 --upgrade "yt-dlp[default,curl-cffi]" \
           && ok=1 && break; \
         echo "pip install attempt $attempt failed, retrying in 5s..."; \
         sleep 5; \
       done; \
       [ "$ok" -eq 1 ] \
    && /opt/ytdlp-venv/bin/yt-dlp --version \
    && /opt/ytdlp-venv/bin/yt-dlp --list-impersonate-targets | grep -qi firefox \
    && /opt/ytdlp-venv/bin/python -m pip uninstall -y pip setuptools wheel \
    && rm -rf /root/.cache/pip \
    && find /opt/ytdlp-venv -type d -name "__pycache__" -prune -exec rm -rf {} + \
    && find /opt/ytdlp-venv -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete

FROM alpine:3.24 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PORT=3000
ENV API_PORT=5000
ENV HOSTNAME=0.0.0.0
ENV INTERNAL_API_URL=http://127.0.0.1:5000
ENV DOWNLOADS_DIR=/data/downloads
ENV COOKIES_DIR=/data/cookies
ENV APP_ROLE=all
ENV PATH="/opt/ytdlp-venv/bin:${PATH}"

RUN apk add --no-cache nodejs python3 libffi libstdc++ libgcc ca-certificates ffmpeg \
    && mkdir -p /data/downloads /data/cookies /app/server /app/client

COPY --from=ytdlp-builder /opt/ytdlp-venv /opt/ytdlp-venv
COPY --from=server-deps /build/server/node_modules /app/server/node_modules
COPY server/package.json /app/server/package.json
COPY server/src /app/server/src
COPY --from=client-builder /build/client/public /app/client/public
COPY --from=client-builder /build/client/.next/standalone /app/client/
COPY --from=client-builder /build/client/.next/static /app/client/.next/static
COPY docker/entrypoint.js /app/entrypoint.js

RUN node -v \
    && yt-dlp --version \
    && yt-dlp --list-impersonate-targets | grep -qi firefox \
    && ffmpeg -encoders 2>/dev/null | grep -q libmp3lame

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "/app/entrypoint.js"]
