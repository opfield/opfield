FROM node:24-alpine AS base

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# This Dockerfile is built from the repository root:
#   docker build -f packages/backend/Dockerfile .
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/backend/package.json packages/backend/
RUN pnpm install --frozen-lockfile

FROM base AS builder

COPY packages/backend/ packages/backend/
WORKDIR /app/packages/backend
RUN pnpm build

FROM node:24-alpine AS production

RUN apk add --no-cache openssl && corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY scripts/legacy-compat.sh /tmp/legacy-compat.sh
RUN . /tmp/legacy-compat.sh && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodejs && \
    mkdir -p /var/lib/opfield/tls && \
    chown -R nodejs:nodejs /var/lib/opfield && \
    ln -s /var/lib/opfield "$LEGACY_APP_DATA_DIR" && \
    rm /tmp/legacy-compat.sh

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/backend/package.json packages/backend/
RUN pnpm --filter backend install --prod --frozen-lockfile

WORKDIR /app/packages/backend

COPY --from=builder /app/packages/backend/dist ./dist
COPY --from=builder /app/packages/backend/src/db/migrations ./src/db/migrations
COPY config/update-trust/update-signing-public-key.pem ./dist/lib/update-signing-public-key.pem
COPY config/update-trust/opencodex-signing-public-key.pem ./dist/lib/opencodex-signing-public-key.pem
COPY proto/ /app/proto/
COPY skills/ /app/skills/

USER nodejs

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
