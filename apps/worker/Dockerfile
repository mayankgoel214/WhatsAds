# syntax=docker/dockerfile:1
# ─── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json        ./packages/db/
COPY packages/queue/package.json     ./packages/queue/
COPY packages/whatsapp/package.json  ./packages/whatsapp/
COPY packages/session/package.json   ./packages/session/
COPY packages/payment/package.json   ./packages/payment/
COPY packages/storage/package.json   ./packages/storage/
COPY packages/ai/package.json        ./packages/ai/
COPY apps/worker/package.json        ./apps/worker/

RUN pnpm install --frozen-lockfile --filter @autmn/worker...

# ─── Stage 2: build ───────────────────────────────────────────────────────────
FROM deps AS builder
COPY tsconfig.base.json ./
COPY packages/db/       ./packages/db/
COPY packages/queue/    ./packages/queue/
COPY packages/whatsapp/ ./packages/whatsapp/
COPY packages/session/  ./packages/session/
COPY packages/payment/  ./packages/payment/
COPY packages/storage/  ./packages/storage/
COPY packages/ai/       ./packages/ai/
COPY apps/worker/       ./apps/worker/

RUN pnpm --filter @autmn/db build
RUN pnpm --filter @autmn/queue build
RUN pnpm --filter @autmn/whatsapp build
RUN pnpm --filter @autmn/session build
RUN pnpm --filter @autmn/payment build
RUN pnpm --filter @autmn/storage build
RUN pnpm --filter @autmn/ai build
RUN pnpm --filter @autmn/worker build

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
COPY packages/ai/package.json        ./packages/ai/
COPY apps/worker/package.json        ./apps/worker/

RUN pnpm install --frozen-lockfile --filter @autmn/worker... --prod

COPY --from=builder /app/packages/db/dist        ./packages/db/dist
COPY --from=builder /app/packages/queue/dist     ./packages/queue/dist
COPY --from=builder /app/packages/whatsapp/dist  ./packages/whatsapp/dist
COPY --from=builder /app/packages/session/dist   ./packages/session/dist
COPY --from=builder /app/packages/payment/dist   ./packages/payment/dist
COPY --from=builder /app/packages/storage/dist   ./packages/storage/dist
COPY --from=builder /app/packages/ai/dist        ./packages/ai/dist
COPY --from=builder /app/apps/worker/dist        ./apps/worker/dist
COPY --from=builder /app/packages/db/prisma      ./packages/db/prisma

# Worker does NOT run migrations — only the api service does.
CMD ["node", "apps/worker/dist/index.js"]
