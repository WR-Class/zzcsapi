FROM node:20-alpine
# curl: Linux 下 Cloudflare 拦截的回退通道（openai 系渠道探测/聊天用）
# （arena 协议已撤：chromium/nss/freetype 全家桶与 --experimental-websocket 一并移除，镜像 1.31GB → 瘦身）
RUN apk add --no-cache curl ca-certificates
WORKDIR /app
COPY server.js ./
COPY notion.js ./
COPY notion-agent.js ./
COPY tool-emu.js ./
COPY console.html ./
COPY config.example.json ./config.json
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server.js"]
