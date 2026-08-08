# Multi-arch (amd64 + arm64 for Pi/NAS) — build with `docker buildx build --platform linux/amd64,linux/arm64`.
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json ./
COPY shared/package.json shared/
COPY service/package.json service/

RUN npm install

COPY tsconfig.base.json ./
COPY shared ./shared
COPY service ./service

RUN npm run build --workspace @stremio-offline/shared \
 && npm run build --workspace @stremio-offline/service

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV STORAGE_ROOT=/data
ENV PORT=11470

COPY package.json ./
COPY shared/package.json shared/
COPY service/package.json service/
RUN npm install --omit=dev

COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/service/dist ./service/dist
COPY service/db/schema.sql ./service/db/schema.sql

VOLUME ["/data"]
EXPOSE 11470 12470

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||11470)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "service/dist/index.js"]
