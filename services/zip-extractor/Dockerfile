# Haxe zip-extractor (ADR-058). Tiny Node service; runs next to docling on n8n-internal.
FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching. Use npm ci against the committed lockfile.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY app.mjs ./

ENV PORT=8080
EXPOSE 8080

# Bounded-memory by design (streams to disk); still run unprivileged.
USER node

HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=10s \
  CMD node -e "fetch('http://localhost:'+ (process.env.PORT||8080) +'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app.mjs"]
