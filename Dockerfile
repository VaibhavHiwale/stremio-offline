# Multi-arch (amd64 + arm64 for Pi/NAS) — build with `docker buildx build --platform linux/amd64,linux/arm64`.
#
# Four workspaces now (shared, addon, dashboard, service — dashboard and
# addon didn't exist yet the first time this file was written, P9/P2
# respectively). Build order matches the root package.json build script:
# shared -> addon -> dashboard -> service. The runtime stage only installs
# shared/addon/service's production deps (dashboard is pure static output
# by then, nothing at runtime imports the dashboard *package* — see
# service/src/api/dashboardStatic.ts, which serves files from a directory,
# not a module) — confirmed empirically that `npm ci`/`npm install` in a
# workspace root tolerate a workspace listed in package.json whose folder
# isn't present on disk (skipped silently, exit 0), so omitting
# dashboard/package.json from the runtime stage's COPY is safe, not a bug
# waiting to happen.
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY addon/package.json addon/
COPY dashboard/package.json dashboard/
COPY service/package.json service/

RUN npm ci

COPY tsconfig.base.json ./
COPY shared ./shared
COPY addon ./addon
COPY dashboard ./dashboard
COPY service ./service

RUN npm run build --workspace @stremio-offline/shared \
 && npm run build --workspace @stremio-offline/addon \
 && npm run build --workspace @stremio-offline/dashboard \
 && npm run build --workspace @stremio-offline/service

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV STORAGE_ROOT=/data
# Matches service/src/index.ts's actual env var names — CLAUDE.md §3's
# HTTP-on-11470/HTTPS-on-12470 convention. (A prior version of this file
# set `PORT`, which the service never reads; the healthcheck below only
# ever "worked" by coincidence, because 11470 is also the default.)
ENV HTTP_PORT=11470
ENV HTTPS_PORT=12470

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY addon/package.json addon/
COPY service/package.json service/
RUN npm ci --omit=dev

COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/addon/dist ./addon/dist
COPY --from=build /app/dashboard/dist ./dashboard/dist
COPY --from=build /app/service/dist ./service/dist
COPY service/db/schema.sql ./service/db/schema.sql

VOLUME ["/data"]
EXPOSE 11470 12470

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||11470)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "service/dist/index.js"]
