FROM node:20-alpine
# curl: Linux 下 Cloudflare 拦截的回退通道（openai 系渠道探测/聊天用）
# （arena 协议已撤：chromium/nss/freetype 全家桶与 --experimental-websocket 一并移除，镜像 1.31GB → 瘦身）
RUN apk add --no-cache curl ca-certificates
WORKDIR /app
COPY server.js ./
COPY notion.js ./
COPY notion-agent.js ./
COPY tool-emu.js ./
# hark 网页会话渠道（v1.18.47）：server.js 运行期 `require('./hark.js')`。
# ⚠️ 这份清单是**白名单**——新增被 require 的文件必须同时加到这里，漏了就只会表现为
#    容器启动即 crash-loop（`MODULE_NOT_FOUND`，requireStack 指向 /app/server.js），
#    而本机 `node server.js` 一切正常（因为工作目录里那个文件在）。由 test/docker-image-files.test.js 守住。
COPY hark.js ./
COPY font-assets.js ./
COPY console.html ./
# 自托管字体分片（v1.18.37）：/console/fonts/** 由 font-assets.js 从这份目录发出去。
# 不加这行容器里就没有字体，控制台会静默回落到系统字体（页面不报错，只是字变了）。
COPY assets/fonts ./assets/fonts
COPY config.example.json ./config.json
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server.js"]
