FROM node:20-alpine
# curl 用于绕过 Cloudflare 的 Linux 回退
RUN apk add --no-cache curl
WORKDIR /app
COPY server.js ./
COPY console.html ./
COPY config.example.json ./config.json
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server.js"]
