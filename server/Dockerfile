FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages --upgrade "yt-dlp[default]"

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data/downloads /data/cookies

EXPOSE 5000

CMD ["node", "src/api.js"]
