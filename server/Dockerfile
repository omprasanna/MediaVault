FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages --upgrade "yt-dlp[default]"
RUN ok=0; for attempt in 1 2 3 4 5; do \
      pip3 install --break-system-packages --default-timeout=45 --retries 5 --upgrade "yt-dlp[default,curl-cffi]" \
        && ok=1 && break; \
      echo "pip3 curl-cffi install attempt $attempt failed, retrying in 5s..."; \
      sleep 5; \
    done; \
    rm -rf /root/.cache/pip; \
    [ "$ok" -eq 1 ]

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data/downloads /data/cookies

EXPOSE 5000

CMD ["node", "src/api.js"]
