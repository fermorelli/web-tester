FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN mkdir -p public && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation fonts-noto-color-emoji tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    APP_HOST=0.0.0.0 \
    CHROME_PATH=/usr/bin/chromium \
    DATABASE_PATH=/data/seo-analyzer.db
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/scripts ./scripts
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/start.mjs", "--railway"]
