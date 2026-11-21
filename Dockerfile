FROM node:22-alpine

# Runs as root on purpose: it must write mp3/sidecar files into the
# /data/tts-cache bind mount, which is owned by the host user.
WORKDIR /app

COPY server.js package.json ./
COPY public/ ./public/

EXPOSE 8080

CMD ["node", "server.js"]
