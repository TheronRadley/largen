# Largen has no npm dependencies, so there is no install step.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    LARGEN_DATA_DIR=/data

COPY package.json ./
COPY src ./src
COPY frontend ./frontend

# Conversations are stored here. Mount a volume to keep them across restarts.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1

CMD ["node", "src/server.js"]
