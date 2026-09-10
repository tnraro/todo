# Multi-stage: build the web app, then ship server sources + dist on Bun.
# The server has zero runtime npm deps (bun:sqlite is built in); the runner
# only needs workspace links, so production install is tiny.
FROM oven/bun:1-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production \
  PORT=3001 \
  TODO_DB=/data/app.db
COPY package.json bun.lock ./
COPY packages/shared packages/shared
COPY packages/server packages/server
# Workspace manifests must all be present or the frozen lockfile check fails.
COPY packages/web/package.json packages/web/
RUN bun install --production --frozen-lockfile
COPY --from=build /app/packages/web/dist packages/web/dist
VOLUME /data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://localhost:'+(process.env.PORT||'3001')+'/api/projects/nope').then(r=>{if(r.status!==404)process.exit(1)})"
CMD ["bun", "packages/server/src/index.ts"]
