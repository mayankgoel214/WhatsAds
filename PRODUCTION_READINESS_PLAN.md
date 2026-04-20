# Plan: Autmn Production-Readiness Baseline

**Owner:** architect
**Date:** 2026-04-20
**Status:** Proposed — awaiting founder P0 sign-off
**Companion ADR:** `docs/adr/0001-production-readiness-baseline.md`

---

## Goal

Bring the Autmn WhatsApp-AI-photography backend (`~/Autmn/`) to a production-quality baseline: the live bugs observed today stop happening, the 12-gate Definition of Done is enforced at merge time (adapted to a backend-only stack), and a founder-supervised incident in production is survivable within the incident-runbook.

## Non-goals

- **Line-by-line code review of every file.** Infeasible and low-ROI for a 10-package monorepo. We audit by tier and by blast radius instead.
- **Rewriting Autmn draft 1 into the new greenfield repo.** This plan is repair-in-place; the fresh repo is a separate track.
- **Shipping new features.** No new styles, new pipelines, new payment flows. Stabilization only.
- **Frontend / Next.js work.** There is no Next.js app. Lighthouse, Vercel bundle-size, Server Components, App Router — all N/A. See ADR-0001 for which DoD gates we keep.
- **Hitting 100% test coverage.** Target 70% on `packages/session` + `packages/ai` core, 40% elsewhere. Tests live on pure functions and the webhook-to-state-machine boundary.

---

## Approach

**Tier the audit by blast radius.** Every WhatsApp message hits a ~7-step hot path: `POST /webhooks/whatsapp` → `extractMessage` → `handleIncomingMessage` → handler → `transitionTo` → BullMQ enqueue → worker → pipeline → Supabase + WhatsApp write. Any defect on that path affects 100% of users on every message. That's **Tier A** and gets deep scrutiny (~12 files). **Tier B** is support code that only fires on specific events — payment webhooks, admin routes, message templates, db helpers. Audit for correctness + add unit tests. **Tier C** is experimental / draft code — V3 vs V4 vs V5 pipeline variants, admin test UI, unused fallback branches. For each C file we answer one question: keep (wire into CI + tests) or cut (delete). Today `packages/ai/src/pipeline/` has 22 files with overlapping names (`gemini-pipeline.ts`, `-v3`, `-v4`, `-v5`); three of those four are dead weight.

**Gap the current state against Definition of Done.** We adapt the 12 DoD gates for a backend-only service (see ADR-0001). Kept as-is: typecheck, Biome, Vitest, Supabase migration diff, gitleaks, changesets, Playwright smoke. Dropped as N/A: `next build`, Vercel preview, Lighthouse, bundle-size diff. Added: `supabase db advisors` (RLS + index linter), Bull Board smoke, BullMQ queue-drain health check. Wire each kept gate into GitHub Actions — today zero of them run on PR.

**Sequence the work in four priority bands.** P0 is "stop the bleeding" — the four bugs from today's live test, plus credential rotation. P1 is one-PR DoD wiring: CI, gitleaks, pre-commit. P2 is testing scaffolding — Vitest on hot-path pure functions + one Playwright smoke. P3 is sweep work: dead-code removal, structured-logging standardization, index/migration hygiene, observability. Each band is designed to merge independently so the founder can pause the plan between bands without leaving the repo half-migrated.

---

## Remediation workstreams (grouped by theme, not by file)

### Workstream 1 — AI pipeline reliability (P0)

Owner: `implementer` + `qa-playwright`

The hot path in the pipeline is broken in three independent ways observed in today's logs:

- **Light-analyzer 10s timeout fires on ~100% of 3-photo orders.** `packages/ai/src/pipeline/light-analyzer.ts:84` hardcodes `TIMEOUT_MS = 10_000`, then the Zod schema silently coerces `productName` → `"product"` on any parse failure via `.catch('product')`. Downstream prompt generation loses product identity, so generation produces wrong colors / wrong logos / missing brand. **Fix:** raise timeout to 30s for 3+ buffer calls, downgrade schema defaults from silent coercion to a retry with a shorter, structured prompt. Also: log the raw Gemini response when the parse fails so we can see whether this is a timeout or a schema mismatch.
- **V5 QA does nothing.** `simple-qa.ts` checks three booleans and never blocks a selection. V3's `combinedQualityCheck` had product-fidelity scoring with a 25-pt floor; V5 threw it away. **Fix:** either restore `combinedQualityCheck` as the gate for V5 candidate selection, or delete V5 and roll back to V3 until there's a replacement with equivalent fidelity-checking. Do not ship V5 as the default path until QA is equivalent.
- **Candidate scoring is decorative.** Logs show `pass:false, fill:50` but the winner is still selected because nothing reads those fields as a gate. **Fix:** make candidate selection a composite score (fidelity × fill × pass) with a minimum threshold; if nothing clears the threshold, fall through to Tier 2 (styled studio), which already works.

**Secondary pipeline hygiene (P3):**
- 22 files in `packages/ai/src/pipeline/`. Audit which are live: likely `never-fail-pipeline.ts`, the selected V{N}, `styled-studio.ts`, `orchestrator.ts`, `preprocess.ts`, `fallback.ts`, a QA file. Anything unused gets deleted, not commented out.
- Circuit-breaker (`circuit-breaker.ts`) — check whether it's wired into any pipeline entry point or vestigial.

### Workstream 2 — Webhook UX bug (P0)

Owner: `implementer`

`apps/api/src/routes/webhooks/whatsapp.ts:164-177` treats anything not in `['text','image','audio','interactive']` as `unknown` and sends the "I can only process photos" message. During today's test this fired three times before the "3 photos received" confirmation — suggests some media wrapper message-type (reaction echo, read receipt envelope, or a pre-media metadata event) was slipping into the `unknown` branch. **Fix:** (1) log the raw `rawType` on every unknown to identify what Meta is actually sending; (2) only send the fallback text if the message is genuinely an end-user-visible unsupported type (sticker, reaction, location, contact) — not if it's a system envelope; (3) de-dupe: if we already sent the unsupported-type message within the last 10 seconds to this phone, skip it.

### Workstream 3 — Testing infrastructure (P2)

Owner: `qa-playwright` + `implementer`

No Vitest, no Playwright, no CI tests today. Minimum viable coverage:

- **Vitest on pure functions.** Priority targets:
  - `packages/session/src/db-helpers.ts` — `transitionTo` (upsert semantics, stateEnteredAt, errors)
  - `packages/session/src/machine.ts` — `isEscapeIntent` (the regex list is load-bearing)
  - `packages/session/src/handlers/instructions.ts` — `parsePerStyleInstructions` (mentioned in git log as recently fixed; needs regression lock)
  - `packages/ai/src/pipeline/fallback.ts` — `postProcessFinal` across all 8 styles (golden-image snapshot)
  - `packages/whatsapp/` — `extractMessage`, `getMessageType`, `verifyWebhookSignature` (HMAC must be right)
  - `packages/payment/` — signature verify
- **Integration test on webhook → state machine.** One test file that POSTs a raw Meta webhook payload fixture and asserts the DB state transition. Mock WA client. No network.
- **Playwright smoke on `/admin/test`.** The admin test UI mentioned in the latest commit is the only UI surface. One smoke path: load UI, upload a fixture image, assert a result renders. This also exercises auth (admin secret header).
- **Target coverage:** `packages/session` 70%, `packages/ai` core 60% (pipeline entry + QA + routing), everything else 40%. Coverage gate in CI is `>=40%` on changed files.

### Workstream 4 — Observability (P3)

Owner: `sre`

- Structured logging is inconsistent: some files use `console.log(JSON.stringify({...}))`, others use `app.log.info()`, the session package has its own `logger.ts`. Standardize on a single `createLogger(service: string)` factory in `packages/shared` (new package) that emits pino-compatible JSON. Every event has `event`, `service`, `phoneNumber` (if present), `orderId` (if present), `traceId`.
- **Sentry is not wired.** Stack playbook expects it; the repo has no `@sentry/node` import anywhere. Add Sentry in both `apps/api` and `apps/worker` boot paths with source-map upload in CI. Filter out `orderId`/`phoneNumber` from PII auto-capture.
- **PostHog event plan:** `message_received`, `photo_uploaded`, `payment_link_sent`, `payment_confirmed`, `image_processing_started`, `image_delivered`, `order_completed`, `feedback_loved`, `feedback_edit_requested`. Server-side capture with `distinctId = phoneNumber`. Revenue events include `amount_inr`, `imageCount`, `style`.
- **Bull Board is already mounted at `/admin/queues`.** Add auth-header check (today it's behind ADMIN_SECRET only in prod-mode — verify the header check actually rejects missing headers, don't assume).

### Workstream 5 — Security hygiene (P1)

Owner: `security-auditor`

- **Rotate all keys exposed in the session transcript today.** WhatsApp access token, fal.ai key, Gemini key, Groq key, Sarvam key, Razorpay key ID, webhook secret, Supabase service role, Redis URL. Assume compromised. Rotate and force `.env` redownload.
- **gitleaks history scan.** Run `gitleaks detect --log-opts="--all"` against the full history. If any key-shaped string appears in a past commit, rewrite history (only while `main` is solo-owned) or accept and document.
- **Pre-commit hook:** `gitleaks` in lefthook / husky on every commit. Blocks commits that match the secret regex.
- **Webhook HMAC verification in production.** `apps/api/src/routes/webhooks/whatsapp.ts` already skips when `WHATSAPP_APP_SECRET === 'placeholder'` — verify this is ONLY a dev path. Add a startup assertion: if `NODE_ENV === 'production'` and the secret is `placeholder` or empty, `process.exit(1)` (same pattern as the `PAYMENT_BYPASS` guard).
- **Admin routes.** `/admin/queues` and `/admin/test` — confirm both require `x-admin-secret` header in production and constant-time compare the value (avoid timing leak).
- **Supabase RLS audit.** `mcp__supabase__get_advisors` against the project. Every table in the schema should have RLS enabled; exceptions explicitly approved. Run once, add to CI as a check.

### Workstream 6 — Code quality sweep (P3)

Owner: `code-reviewer`

- **Biome config audit.** One `biome.json` at root. Rules set to production-strict: `noExplicitAny = error` (today lots of `as any` in webhook parsing — see `msg as any` in `whatsapp.ts:181`; tighten by typing `RawWebhookMessage`), `noNonNullAssertion = warn`, `useExhaustiveDependencies = error`. Run `biome check --apply` once, review diff, commit.
- **TypeScript strict audit.** `strict: true` in every `tsconfig.json` with no package relaxing it. Run `tsc --noEmit` on CI.
- **Dead-code removal.** Use `ts-prune` or `knip` to find unused exports. Expected hit list: old V3/V4 pipeline variants, old QA files (`combined-qa.ts` vs `focused-checks.ts` vs `simple-qa.ts`), unused fallback branches, old product analyzer files.
- **Kill `console.log` / `console.error` in handlers** — either route to the session logger or to pino via API's Fastify context. Acceptable only in pipeline internals (already JSON-structured) and the worker processor (where it's JSON-structured).

### Workstream 7 — Data model hygiene (P1)

Owner: `implementer` + `sre`

Prisma schema needs index and retention review:

- **Indexes missing on hot queries** (confirm against `schema.prisma`):
  - `ProcessedMessage.messageId` — primary key, fine.
  - `Session.phoneNumber` — unique, fine.
  - `Order.razorpayPaymentLinkId` — **add index**, used in payment webhook lookup.
  - `Order.razorpayPaymentId` — **add index**, secondary webhook lookup.
  - `WebhookEvent.source` + `WebhookEvent.createdAt` — composite index for audit queries.
  - `ImageJob.orderId` — should be indexed (foreign key → but confirm Prisma created it).
- **Retention policy:** `WebhookEvent` grows unbounded. Add a cron (BullMQ delayed-repeating job) that deletes records older than 30 days. Same for `ProcessedMessage` — its only purpose is dedupe within a few minutes; TTL 24h is sufficient.
- **Reversibility check:** every migration must be reversible. Add `supabase db diff` in CI that fails on destructive operations without a `-- safe-migration: yes` marker.
- **Soft-delete on `Order`?** Currently hard references in `ImageJob.orderId`. If we ever refund+delete, we break FKs. Add `Order.deletedAt nullable` field and change cascade behaviour. (Defer to P3 — not urgent.)

### Workstream 8 — DoD gate wiring (P1)

Owner: `implementer`

GitHub Actions workflow `.github/workflows/ci.yml` runs on every PR:

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm lint` (Biome)
4. `pnpm test` (Vitest)
5. `pnpm build` (turbo)
6. `gitleaks detect --source=. --verbose`
7. `supabase db diff` (if migrations touched)
8. Changeset check (fails if no `.changeset/*.md` and label != `no-changelog`)
9. Playwright smoke (if `/admin` or webhook files changed)

Pre-commit via lefthook: gitleaks, typecheck on staged packages, Biome format+check.

Merge protection: all checks required, linear history, squash-merge only.

Auto-merge label `autmrg:safe` whitelisted for: Renovate patches/minors, docs-only PRs, test-only PRs.

---

## Data model impact

| Change | Migration shape | Reversible? |
|---|---|---|
| Add index on `Order.razorpayPaymentLinkId` | `CREATE INDEX CONCURRENTLY` | Yes — drop the index. |
| Add index on `Order.razorpayPaymentId` | `CREATE INDEX CONCURRENTLY` | Yes. |
| Composite index on `WebhookEvent(source, createdAt)` | `CREATE INDEX CONCURRENTLY` | Yes. |
| TTL cleanup job for `WebhookEvent` + `ProcessedMessage` | BullMQ repeating job — no schema change | Yes — stop the job. |
| Optional `Order.deletedAt` (deferred) | `ALTER TABLE ADD COLUMN deletedAt timestamptz NULL` | Yes. |

No destructive changes. Every migration goes through `pnpm db:migrate` and is committed. Use `CREATE INDEX CONCURRENTLY` to avoid locking; single-digit row counts today make it trivial, but habit matters for when there are 100k rows.

---

## Third-party touchpoints

Each integration audited for retry / idempotency / timeout / rate-limit handling:

| Service | Retry | Idempotency | Timeout | Rate limit | Gap today |
|---|---|---|---|---|---|
| **Meta WhatsApp Cloud API** | Inbound: Meta retries if we don't 200 within 20s (we do). Outbound: `wa.sendText` et al. should retry once on 5xx. | Inbound via `ProcessedMessage.messageId` — good. Outbound: none needed (duplicate sends rare). | Outbound 10s per call. | 80 msg/sec per phone number (Meta limit). In-memory rate limiter in `whatsapp.ts`. | Verify outbound retry on 5xx; add log on 4xx. |
| **Razorpay Payment Links** | PAYMENT_CHECK BullMQ job at +2min catches missed webhooks — good. | Order is keyed by `order.id`; payment webhook should be idempotent on `event.id` — **confirm**. | 10s on link creation. | 1000 req/min (Razorpay limit). | Confirm webhook idempotency; current code may double-process. |
| **Supabase** (Postgres + Storage) | Prisma retries connection drops; Storage client has no retry — **add retry on upload**. | N/A | Prisma pooled 10s; direct 30s for migrations. | Supabase free tier: 500 conn/min. Worker concurrency=3 is fine. | Storage upload retry on 5xx. |
| **fal.ai** | `never-fail-pipeline.ts` has tier fallback — good. | N/A (generation is not idempotent). | 4min Tier 1, 90s Tier 2. | Not documented; monitor for 429. | Tier 1 timeout is aggressive; logs today show some hits at 3:50. |
| **Gemini (Google AI)** | `lightAnalyze` has no retry on timeout — **fix in P0**. | N/A | 10s today (too tight); 30s after fix. | 60 req/min per project (free tier). | P0. |
| **Groq / Sarvam** (voice) | Groq primary, Sarvam fallback — good pattern. | N/A | 30s. | Groq 30 req/min free tier. | Confirm Sarvam fallback fires on Groq 5xx, not only on timeout. |

---

## Test strategy

**Unit (Vitest) — pure functions only.** Goal: lock-in logic that has zero external IO.
- `transitionTo` — in-memory Prisma mock, assert state + stateEnteredAt.
- `isEscapeIntent` — table-driven test of the regex list.
- `parsePerStyleInstructions` — inputs from today's prod logs.
- `postProcessFinal` — snapshot-match per style with a fixture input buffer.
- `verifyWebhookSignature` — Meta HMAC + Razorpay signature correctness.
- `extractMessage` / `getMessageType` — table-driven against every Meta payload shape we've seen, including the unknown-type bug from today.

**Integration (Vitest) — one file per workflow.** Mocked Meta, mocked Razorpay, real Prisma against a local test DB.
- `webhook-to-idle.test.ts` — new user sends "hi" → state IDLE → SETUP_LANGUAGE.
- `idle-to-delivered.test.ts` — full flow with mocked pipeline, asserts state transitions at each step.
- `payment-missed-webhook.test.ts` — payment check job fires, polls Razorpay mock, transitions to PROCESSING.

**Smoke (Playwright) — one path, against `/admin/test`.** Load admin UI with secret header, upload fixture image, assert result image renders. This also covers admin auth.

**Coverage targets:**
- `packages/session` ≥ 70% line coverage
- `packages/ai` (pipeline entry + QA + routing) ≥ 60%
- `packages/whatsapp` ≥ 80% (signature + extract are critical)
- `packages/payment` ≥ 80% (signature)
- Everything else ≥ 40%
- CI gate: 40% on changed files. No global floor — keeps pipeline honest without blocking docs PRs.

---

## Rollout

Repair-in-place. Four bands, each independently shippable, each with a clear exit criterion:

**P0 — This week (stop the bleeding):**
1. Light-analyzer timeout + schema fallback fix.
2. V5 QA either restored or rolled back to V3.
3. Candidate selection gated on composite score.
4. Webhook unknown-type log + dedupe.
5. Credential rotation.
Exit: no instance of `v5_light_analysis_failed` in a 20-message test run; no duplicate "I can only process photos" on a normal 3-photo flow.

**P1 — Week 2 (DoD one-PR fixes):**
1. GitHub Actions CI workflow.
2. Pre-commit hook (gitleaks, biome, typecheck).
3. Production HMAC + ADMIN_SECRET startup guards.
4. Hot-query indexes + retention job.
5. Sentry boot in API and worker.
Exit: every one of the 9 CI gates is green on a synthetic PR.

**P2 — Week 3 (testing scaffolding):**
1. Vitest installed + unit tests for the targets above.
2. Integration test for webhook → state machine.
3. Playwright smoke on `/admin/test`.
4. Coverage reporting + 40% gate.
Exit: `pnpm test` runs clean locally and in CI.

**P3 — Week 4 (sweep):**
1. Dead-code removal (ts-prune / knip).
2. Structured-logging standardization.
3. PostHog event plan.
4. Biome strict + TypeScript audit.
Exit: `knip` clean; `console.log` count in non-pipeline files is 0.

**Continuous vs gated:**
- P0 and P1 items ship as independent PRs, continuously.
- P2 test additions are continuous.
- P3 dead-code removal gated on a staging session — delete a file, run full dev flow, confirm nothing regresses.

---

## Risks

**Risk 1: founder divides attention between this plan and the greenfield repo.**
The founder has stated he plans to start fresh development in a separate repo. This plan competes for his review time.
*Mitigation:* P0 is scoped to 5 small PRs — ~1 week of founder attention. P1–P3 designed to land without his involvement on green CI + safe-label auto-merge. If the fresh repo takes over, we can pause after P1 with a repo that's at least safe to keep running.

**Risk 2: V5 rollback or revalidation breaks more than it fixes.**
V5 was a recent rewrite that threw out V3's fidelity QA. Reverting risks regressing on whatever V5 improved (possibly: speed, prompt simplicity).
*Mitigation:* Before rollback, run the `/admin/test` suite against 10 fixture images on V3 vs V5 — compare QA pass rate and product-fidelity. Decide from data, not intuition. `qa-playwright` owns this comparison.

**Risk 3: hidden webhook-shape cases we haven't seen yet.**
Meta occasionally adds new message types (e.g., story replies, order messages, business-account verification envelopes). The `unknown` fallback today is over-broad — once we fix that, we may uncover other paths that quietly failed before.
*Mitigation:* P0 workstream 2 adds logging for every `unknown` rawType. Watch for 48h, then codify new types. Low-risk because the 200 OK always fires before extraction.

---

## ADR needed?

**YES** — `docs/adr/0001-production-readiness-baseline.md`.

Rationale: this plan declares which DoD gates are mandatory for a backend-only service (divergence from stack-playbook), and codifies the invariants going forward. That's a one-way-door decision: once we adopt a CI gate set, changing it later requires a new ADR.

---

## Files of note referenced in this plan

- `/Users/lending/Autmn/packages/ai/src/pipeline/light-analyzer.ts` — 10s timeout, silent schema fallbacks
- `/Users/lending/Autmn/packages/ai/src/pipeline/simple-qa.ts` — the neutered V5 QA
- `/Users/lending/Autmn/packages/ai/src/pipeline/gemini-pipeline-v5.ts` — candidate selection without gating
- `/Users/lending/Autmn/apps/api/src/routes/webhooks/whatsapp.ts` — unknown-type triple-fire at lines 164–177
- `/Users/lending/Autmn/packages/session/src/machine.ts` — escape intent + PROCESSING auto-recovery
- `/Users/lending/Autmn/packages/session/src/db-helpers.ts` — `transitionTo`
- `/Users/lending/Autmn/packages/db/prisma/schema.prisma` — Order / Session / ImageJob / WebhookEvent schema
- `/Users/lending/Autmn/apps/api/src/index.ts` + `apps/worker/src/index.ts` — PAYMENT_BYPASS guard (good pattern, replicate for APP_SECRET)
- `/Users/lending/Autmn/docs/adr/0001-production-readiness-baseline.md` — companion ADR

---

## P0-2 Decision — 2026-04-20

**Chosen: Option A — Restore `combinedQualityCheck` as the V5 gate.**

Rationale: V5's structural improvements (LightAnalyze multi-photo analysis, DIRECT track with parallel temperature candidates, deterministic candidate selection, per-style v5 prompts) are the good part of V5 and are worth keeping. The only broken part is the QA gate — `simpleQA` returned 3 uncorrelated booleans with no fidelity scoring, which defaulted every output to a passing score of 75. `combinedQualityCheck` was the exact missing piece: it already accepts `(inputBuffer, outputBuffer, { checkFidelity, voiceInstructions })`, returns a 0–100 score plus a 0–35 `productFidelityScore`, and is what V3 used. Drop-in replacement at a single call site.

Option B (rollback) was rejected because it discards the multi-photo LightAnalyze work and the per-style V5 prompt tuning for zero net gain — V3 also never had multi-photo fidelity verification.

### Implementation summary

- `packages/ai/src/pipeline/gemini-pipeline-v5.ts` — swap `simpleQA` → `combinedQualityCheck`; add `V5_QA_PASS_SCORE = 65`, `V5_QA_FIDELITY_MIN = 25`, `V5_BEST_OF_MIN_SCORE = 55`; disable fidelity scoring for `style_with_model` (Gemini intentionally regenerates the product in the person's hand there); track best-of across 2 attempts; throw to Tier 2 only when best-of is below thresholds.
- `simpleQA` module kept (`packages/ai/src/pipeline/simple-qa.ts`) — still exported for experimental use via the admin test UI but no longer on the hot path.
- Tiers 2/3/4 untouched. Budget: same 3-minute Tier 1 cap; QA call adds ~3–8 s per attempt. Worst-case with 2 retries: still inside the 3-minute cap.

### Follow-ups flagged while reading

- **P1 candidate**: V5 still doesn't pass `brandingInventory` / `isPairedProduct` / `productPhysicalSize` hints into QA (`unifiedQualityCheck` supports all three, `combinedQualityCheck` supports none). If branded-product fidelity still slips, migrating V5 → `unifiedQualityCheck` with a built branding inventory from `lightAnalyze.items[]` would be the next step.
- **P1 candidate**: `simpleQA` error handling silently returns `pass: true` on timeout (`fallback: 'optimistic pass'`). Now that it's off the hot path this is less urgent, but if anyone wires it back in for the admin test UI, that default needs to flip to `pass: false` or it will mask regressions.
- **P2 candidate**: `combinedQualityCheck` conservative-defaults on timeout returns `pass: false, score: 55, productFidelityScore: 20` — this means a QA timeout will always fall through to "deliver best-of" (if another attempt passed) or Tier 2. Confirm that's the intended behavior; it is defensible but worth documenting.
