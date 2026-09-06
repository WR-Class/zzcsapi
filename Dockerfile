FROM node:20-alpine
# curl: Cloudflare 的 Linux 回退（openai 系渠道用）
# chromium nss freetype ttf-freefont: arena.ai 协议的浏览器 sidecar（真实 Chrome 指纹过 CF + reCAPTCHA）
# node 20 需 --experimental-websocket 开启内置 WebSocket（CDP 客户端用）；node 22+ 无需该 flag
RUN apk add --no-cache curl chromium nss freetype harfbuzz ttf-freefont ca-certificates
ENV ZZCSAPI_CHROMIUM=/usr/bin/chromium-browser
WORKDIR /app
COPY server.js ./
COPY notion.js ./
COPY arena.js ./
COPY tool-emu.js ./
COPY console.html ./
COPY config.example.json ./config.json
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "--experimental-websocket", "server.js"]
