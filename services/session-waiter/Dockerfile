# Haxe session-waiter (ADR-066). Tiny always-on Node service; runs next to queue-consumer /
# zip-extractor on the n8n-internal network. Skeleton (Block 4): health + handoff persistence +
# structured logging. The event loop (SSE/long-poll the session, service client tools, deliver_output
# capture, finish callback) lands in Block 6.
FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching. Use the committed lockfile when present.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY app.mjs ./
COPY lib ./lib

ENV PORT=8080
EXPOSE 8080

# Run unprivileged.
USER node

HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=10s \
  CMD node -e "fetch('http://localhost:'+ (process.env.PORT||8080) +'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app.mjs"]
