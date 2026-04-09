# syntax=docker/dockerfile:1
# ─── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json        ./packages/db/
COPY packages/queue/package.json     ./packages/queue/
COPY packages/whatsapp/package.json  ./packages/whatsapp/
COPY packages/session/package.json   ./packages/session/
COPY packages/payment/package.json   ./packages/payment/
COPY packages/storage/package.json   ./packages/storage/
COPY apps/api/package.json           ./apps/api/

RUN pnpm install --frozen-lockfile --filter @whatsads/api...

# ─── Stage 2: build ───────────────────────────────────────────────────────────
FROM deps AS builder
COPY tsconfig.base.json ./
COPY packages/db/       ./packages/db/
COPY packages/queue/    ./packages/queue/
COPY packages/whatsapp/ ./packages/whatsapp/
COPY packages/session/  ./packages/session/
COPY packages/payment/  ./packages/payment/
COPY packages/storage/  ./packages/storage/
COPY apps/api/          ./apps/api/

# Generate Prisma client then build dependency packages, then api
RUN pnpm --filter @whatsads/db build
RUN pnpm --filter @whatsads/queue build
RUN pnpm --filter @whatsads/whatsapp build
RUN pnpm --filter @whatsads/session build
RUN pnpm --filter @whatsads/payment build
RUN pnpm --filter @whatsads/storage build
RUN pnpm --filter @whatsads/api build

# ─── Stage 3: runner ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

ENV NODE_ENV=production

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json        ./packages/db/
COPY packages/queue/package.json     ./packages/queue/
COPY packages/whatsapp/package.json  ./packages/whatsapp/
COPY packages/session/package.json   ./packages/session/
COPY packages/payment/package.json   ./packages/payment/
COPY packages/storage/package.json   ./packages/storage/
COPY apps/api/package.json           ./apps/api/

RUN pnpm install --frozen-lockfile --filter @whatsads/api... --prod

# Copy compiled output from builder
COPY --from=builder /app/packages/db/dist        ./packages/db/dist
COPY --from=builder /app/packages/queue/dist     ./packages/queue/dist
COPY --from=builder /app/packages/whatsapp/dist  ./packages/whatsapp/dist
COPY --from=builder /app/packages/session/dist   ./packages/session/dist
COPY --from=builder /app/packages/payment/dist   ./packages/payment/dist
COPY --from=builder /app/packages/storage/dist   ./packages/storage/dist
COPY --from=builder /app/apps/api/dist           ./apps/api/dist

# Prisma: copy schema and generated client (already baked into node_modules via postinstall)
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma

EXPOSE 3000

# Run migrations then start (Railway sets DATABASE_URL at runtime)
CMD ["sh", "-c", "npx prisma migrate deploy --schema ./packages/db/prisma/schema.prisma && node apps/api/dist/index.js"]
