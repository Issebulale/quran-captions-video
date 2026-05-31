FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive

# FFmpeg for video, Chromium for rendering Arabic text, plus fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    chromium \
    fonts-hosny-amiri \
    fonts-noto-core \
    fonts-liberation \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
