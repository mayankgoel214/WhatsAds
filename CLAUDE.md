# Clickkar — Engineering Context for Claude Code

## Product Overview

Clickkar is a WhatsApp-based AI product photography service for Indian small business owners. A user sends a product photo via WhatsApp, pays Rs 99, and receives a professional AI-generated advertisement image — delivered back on WhatsApp within minutes.

Target users: Indian SMB sellers on Instagram/WhatsApp (jewellery, food, garments, skincare, home decor). They don't know Photoshop, and they can't afford a photographer. Clickkar is their solution — bas ek photo, professional ad ready.

The core value prop:
- Works entirely inside WhatsApp — no app download required
- Rs 99 per image (first one free)
- AI generates a proper ad background, the real product pixels are preserved
- Delivered in under 5 minutes

---

## Internal Package Scope

All packages are scoped under `@whatsads/*` — NOT `@clickkar/*`.

The root `package.json` name is `whatsads`. This is the internal codename. The brand name shown to users is **Clickkar**. Do not use `@clickkar/` when referencing workspace packages. Always use `@whatsads/`.

---

## Monorepo Structure

```
Clickkar/
├── apps/
│   ├── api/          @whatsads/api     — Fastify HTTP server: WhatsApp + Razorpay webhooks, Bull Board UI
│   └── worker/       @whatsads/worker  — BullMQ workers: image processing, payment check, session timeout
├── packages/
│   ├── ai/           @whatsads/ai      — All AI pipelines, QA, transcription, video generation
│   ├── db/           @whatsads/db      — Prisma client + schema (Supabase/Postgres)
│   ├── payment/      @whatsads/payment — Razorpay Payment Links integration
│   ├── queue/        @whatsads/queue   — BullMQ queue definitions, job schemas, Redis connection
│   ├── session/      @whatsads/session — State machine, all session handlers, message templates
│   ├── storage/      @whatsads/storage — Supabase Storage wrapper (upload, download, getPublicUrl)
│   └── whatsapp/     @whatsads/whatsapp — WhatsApp Cloud API client, webhook parsing, signature verification
└── .env              — Single env file at root, loaded by both apps with dotenv
```

**Runtime split:** `@whatsads/api` handles all inbound traffic and responds to Meta within 20 seconds. Heavy work (AI image generation) runs in `@whatsads/worker` via BullMQ jobs. Both apps load the same root `.env` file using `resolve(import.meta.dirname, '../../../.env')`.

---

## Architecture: How a WhatsApp Message Becomes a Delivered Ad

```
WhatsApp User
     |
     | (sends message)
     v
Meta Cloud API
     |
     | POST /webhooks/whatsapp
     v
apps/api — whatsappWebhookRoutes()
     |  1. Rate limit check (60 req/min per IP, in-memory)
     |  2. HMAC signature verify (X-Hub-Signature-256) — production only
     |  3. reply.code(200).send('OK')  ← Meta satisfied immediately
     |  4. Store raw payload → prisma.webhookEvent.create()
     |  5. extractMessage() + getMessageType() from @whatsads/whatsapp
     |  6. Build MessageContext { messageId, messageType, text, mediaId, ... }
     |  7. wa.markAsRead(message.id)
     v
handleIncomingMessage() — packages/session/src/machine.ts
     |  1. checkAndMarkProcessed(messageId) — idempotency via ProcessedMessage table
     |  2. getOrCreateUser(phoneNumber)
     |  3. getSession() or create with transitionTo(phoneNumber, 'IDLE')
     |  4. Update lastUserMessageAt + cswExpiresAt (+24h) on every message
     |  5. switch(session.state) → dispatch to correct handler
     v
Handler (e.g., handleAwaitingPhoto in packages/session/src/handlers/images.ts)
     |  — Downloads WhatsApp media (5-min expiry window)
     |  — Uploads to Supabase raw-images bucket
     |  — After 45s timer OR "done" text → advanceToPayment()
     v
createOrderAndSendPayment() — packages/session/src/handlers/instructions.ts
     |  — Creates Order record (status: payment_pending)
     |  — Creates Razorpay Payment Link (Rs 99 × imageCount, or free if orderCount === 0)
     |  — Sends payment link + WhatsApp buttons to user
     |  — transitionTo(phoneNumber, 'AWAITING_PAYMENT')
     |  — Schedules PAYMENT_CHECK job (+2 min delay via BullMQ)
     v
Razorpay POST /webhooks/razorpay  (user pays)
     |  — Verifies Razorpay signature
     |  — Updates Order.status → payment_confirmed
     |  — Creates ImageJob record(s) for each image
     |  — Enqueues image-processing job on BullMQ
     |  — transitionTo(phoneNumber, 'PROCESSING')
     v
apps/worker — processImageJob()
     |  — Parses ImageProcessingJobDataSchema
     |  — Calls processImageNeverFail({ imageUrl, style, productCategory, voiceInstructions })
     |  — Uploads output + cutout to processed-images bucket
     |  — prisma.imageJob.update(status: 'completed')
     |  — prisma.order.update(outputImageUrls, status: 'completed')
     |  — Calls sendProcessedImages() → wa.sendImage() + wa.sendButtons()
     |  — prisma.session.updateMany(state: 'DELIVERED')
     v
WhatsApp User receives ad image + feedback buttons
     (Love it / Make a change / New style)
```

**CSW window:** `cswExpiresAt` is set to `Date.now() + 24 * 60 * 60 * 1000` on every inbound message. This represents the WhatsApp Customer Service Window (24h). The bot can only send free-form messages while within this window.

---

## Session State Machine

**File:** `packages/session/src/machine.ts`
**Types file:** `packages/session/src/types.ts`

### All States (enum `SessionState` in Prisma schema)

| State | Handler | Description |
|---|---|---|
| `IDLE` | `handleIdle()` in `onboarding.ts` | Entry point. New users → SETUP_LANGUAGE. Returning users with saved style → confirm style or show style picker. |
| `SETUP_LANGUAGE` | `handleSetupLanguage()` in `onboarding.ts` | User picks Hindi (`lang_hi`) or English (`lang_en`) via buttons. |
| `SETUP_NAME` | `handleSetupName()` in `onboarding.ts` | User types their name. Sanitized and truncated to 50 chars. |
| `SETUP_CATEGORY` | `handleSetupCategory()` in `onboarding.ts` | User picks business category from a WhatsApp list. IDs: `cat_jewellery`, `cat_food`, `cat_garment`, `cat_skincare`, `cat_candle`, `cat_bag`, `cat_general`. |
| `SETUP_STYLE` | `handleSetupStyle()` in `style.ts` | User picks style from a WhatsApp list. IDs: `style_clean_white`, `style_lifestyle`, `style_gradient`, `style_outdoor`, `style_studio`, `style_festive`, `style_minimal`, `style_with_model`. If `session.currentOrderId` exists, immediately re-enqueues the job (style-change edit path). |
| `AWAITING_PHOTO` | `handleAwaitingPhoto()` in `images.ts` | Collects 1–5 product photos. Each photo downloaded + uploaded to Supabase immediately. 45s BullMQ timer auto-advances. Max: `MAX_IMAGES_PER_ORDER = 5`. |
| `AWAITING_PAYMENT` | `handleAwaitingPayment()` in `payment.ts` | Waiting for Razorpay payment. PAYMENT_CHECK job fires after `PAYMENT_CHECK_DELAY_MS = 120_000` ms. |
| `PROCESSING` | Inline in `machine.ts` | AI pipeline running. No handler — sends "processing" message. Auto-recovery after 10 minutes: resets to IDLE. Escape hatch: greeting text resets to IDLE. |
| `DELIVERED` | `handleDelivered()` in `delivery.ts` | Image delivered. Handles feedback buttons: `feedback_great` (increments orderCount, saves lastStyleUsed) / `feedback_change` (opens edit list) / `try_new_style` (→ SETUP_STYLE keeping currentOrderId). |
| `EDIT_PROCESSING` | Inline in `machine.ts` | Edit re-processing. Auto-recovery after 5 minutes: resets to DELIVERED. |

### How `transitionTo` Works

`transitionTo(phoneNumber, newState, extraFields?)` in `packages/session/src/db-helpers.ts`:
- Does a `prisma.session.upsert` — creates or updates
- Always sets `stateEnteredAt = new Date()`
- Accepts optional extra fields to clear/set atomically (e.g., `currentOrderId: null`, `imageMediaIds: []`)
- Throws if no `userId` can be resolved (either passed in `extraFields.userId` or found in existing session)

**Key rule:** Always send the WhatsApp message BEFORE or AFTER calling `transitionTo`, never rely on the message arriving after — the state may already have changed when the handler runs again.

### Escape Intent Detection

`isEscapeIntent()` in `machine.ts` — matches: `hi, hello, hey, hii, hiii, namaste, naya, new, start, shuru, hlo, hlw, cancel, stop, reset, restart, start over, naya karo, band karo`. In PROCESSING and EDIT_PROCESSING states, this resets the session to IDLE.

---

## AI Pipeline Architecture

**Main entry point (used by worker):** `processImageNeverFail()` in `packages/ai/src/pipeline/never-fail-pipeline.ts`

### Never-Fail Tier Hierarchy

```
processImageNeverFail(params)   ← worker always calls this
    │
    ├─ Tier 1: processProductImageV3()      [4-min timeout]
    │   └─ packages/ai/src/pipeline/gemini-pipeline-v3.ts
    │       ├─ preprocessImage()
    │       ├─ analyzeAndPlanV3() — Gemini 2.5 Flash, single call: QA + analysis + branding + prompt
    │       ├─ 3 parallel generation candidates (PARALLEL_CANDIDATES = 3)
    │       │   ├─ Track A (branded): Bria Product Shot → Bria output used directly
    │       │   ├─ Track S (small/flat branded): Flux Pro inpainting (fal-ai/flux-pro/v1/fill)
    │       │   └─ Track B (unbranded/with_model): Seedream full gen (fal-ai/bytedance/seedream/v4.5/edit)
    │       ├─ QA loop: combinedQualityCheck() — QA_PASS_SCORE = 65, QA_FIDELITY_MIN = 25
    │       ├─ Best-attempt fallback (score >= 55)
    │       ├─ Bria Product Shot fallback (fal-ai/bria/product-shot)
    │       └─ Ultimate fallback: studio shot on white
    │
    ├─ Tier 2: createStyledStudioShot()     [90s timeout]
    │   └─ packages/ai/src/pipeline/styled-studio.ts
    │       ├─ BiRefNet background removal (fal-ai/birefnet/v2)
    │       ├─ Style-aware colored/gradient background via sharp
    │       └─ STUDIO_COLOR_POOL: 8 bold colors, randomized
    │
    ├─ Tier 3: createCleanStudioShot()      [2s, zero API calls]
    │   └─ Product on white canvas, pure sharp compositing
    │
    └─ Tier 4: createEnhancedOriginal()     [~500ms, always works]
        └─ Preprocessed + labeled original image
```

### QA System

**`combinedQualityCheck(originalBuffer, outputBuffer, options)`** — `packages/ai/src/qa/combined-qa.ts`
- Uses Gemini to compare input vs output
- Returns `CombinedQASchema`: `{ pass, score (0-100), hasRandomText, hasFundamentalError, productFidelity, productFidelityScore (0-35), sceneQuality, physicallyPlausible, humanAnatomy, productIntegration, issues[] }`
- Pass threshold: `QA_PASS_SCORE = 65` (in `orchestrator.ts`)
- Fidelity minimum: `QA_FIDELITY_MIN = 25` (in `orchestrator.ts`) — only checked for Track A and Track S
- `hasFundamentalError = true` → instant discard, try again
- `hasRandomText = true` → auto-fail (background text that is NOT on the product)

**`runFocusedChecks(imageBuffer)`** — `packages/ai/src/qa/focused-checks.ts`
- Uses Gemini 2.5 Flash with `MODEL = 'gemini-2.5-flash'`, `TIMEOUT_MS = 15_000`
- Fast binary yes/no questions via `askBinaryQuestion()`
- Returns: `{ productCount, hasFundamentalDefect, hasRandomTextOrSketch, hasAnatomyIssue, pass, failReasons[] }`

**`runDeterministicChecks(buffer)`** — `packages/ai/src/qa/deterministic-checks.ts`
- Pure sharp pixel analysis, zero API cost
- Checks: blur, clipping, extreme aspect ratio

### Style Post-Processing

`postProcessFinal(buffer, style?)` in `packages/ai/src/pipeline/fallback.ts` — applied to ALL outputs.
Per-style config (`STYLE_POST_CONFIG`):

| Style | Grain | Vignette | Warmth | Notes |
|---|---|---|---|---|
| `style_clean_white` | 0 | 0.02 | 0 | Ultra-clean, clinical |
| `style_studio` | 2 | 0.06 | +1 | Slight punch |
| `style_gradient` | 5 | 0.18 | -2 | Cinematic dark |
| `style_lifestyle` | 4 | 0.12 | +3 | Warm film look |
| `style_festive` | 3 | 0.14 | +5 | Golden glow |
| `style_outdoor` | 5 | 0.14 | +2 | Organic feel |
| `style_minimal` | 0 | 0.03 | -1 | Architectural |
| `style_with_model` | 3 | 0.10 | +2 | Portrait warmth |

All outputs get `addAILabel()` — stamps "AI Generated by Clickkar" at bottom.

### fal.ai Models Used

| Model ID | Usage |
|---|---|
| `fal-ai/birefnet/v2` | Background removal (BiRefNet) |
| `fal-ai/flux-pro/v1/fill` | Inpainting for Track S (small flat branded products) |
| `fal-ai/bytedance/seedream/v4.5/edit` | Full scene generation for Track B (unbranded/with_model) |
| `fal-ai/bria/product-shot` | Branded product scene placement (Track A + ultimate fallback) |

### Pipeline Routing Logic (V3 / Tier 1)

```
hasBranding = plan.hasBranding || plan.brandingConfidence >= 0.3

isWithModel = style === 'style_with_model'
isSmallFlat = productDimensionality === 'flat_2d' && physicalSize in ['tiny', 'small']

Track S: isSmallFlat && hasBranding   → Flux inpainting (product pixels masked)
Track A: hasBranding && !isWithModel  → Bria Product Shot
Track B: !hasBranding || isWithModel  → Seedream full generation
```

`style_clean_white` and `style_studio` skip generation entirely — studio shot used directly.

---

## Key External APIs & Services

| Service | Package | Purpose |
|---|---|---|
| **WhatsApp Cloud API** (Meta) | `@whatsads/whatsapp` | Send/receive messages, buttons, lists, images, video, mark-as-read |
| **Razorpay** | `@whatsads/payment` | Payment Links (Rs 99 per image), webhook for payment capture |
| **Supabase** | `@whatsads/storage`, `@whatsads/db` | PostgreSQL database (via Prisma) + object storage |
| **Redis (Upstash)** | `@whatsads/queue` | BullMQ job queues |
| **fal.ai** | `@whatsads/ai` | BiRefNet, Flux Pro Fill, Seedream, Bria Product Shot, ESRGAN upscale, CodeFormer |
| **Google AI (Gemini)** | `@whatsads/ai` | `gemini-2.5-flash` — product analysis, prompt generation, QA scoring |
| **Groq** | `@whatsads/ai` | Whisper Turbo — voice note transcription (primary) |
| **Sarvam AI** | `@whatsads/ai` | Hindi speech transcription (fallback to Groq) |

---

## Database Schema (Prisma)

Schema file: `packages/db/prisma/schema.prisma`

### User
Key fields: `id` (uuid), `phoneNumber` (unique), `name`, `language` (default `'hi'`), `businessType` (category id), `lastStyleUsed` (style id), `styleHistory` (JSON `{styleId: count}`), `orderCount`, `totalImages`.

Relations: one `Session`, many `Order`.

### Session
One per phone number. Key fields: `phoneNumber` (unique), `state` (SessionState enum), `currentOrderId`, `styleSelection`, `voiceInstructions`, `imageMediaIds` (String[]), `imageStorageUrls` (String[]), `earlyPhotoMediaId` (multipurpose flag: null / media id / `'awaiting_action'` / `'awaiting_instructions'` / `'order_creating'`), `lastUserMessageAt`, `stateEnteredAt`, `cswExpiresAt`.

### Order
Key fields: `id`, `phoneNumber`, `imageCount`, `style`, `voiceInstructions`, `inputImageUrls` (String[]), `outputImageUrls` (String[]), `cutoutUrls` (String[]), `status` (OrderStatus enum), `amount` (paise), `revisionsUsed`, `maxFreeRevisions` (default 2), `razorpayPaymentLinkId`, `razorpayPaymentLinkUrl`, `razorpayPaymentId`, `qaBestScore`, `productCategory`, `processingStartedAt`, `processingCompletedAt`.

OrderStatus values: `created`, `payment_pending`, `payment_confirmed`, `processing`, `completed`, `failed`, `refunded`.

Relations: one `User`, many `Payment`, many `ImageJob`.

### ImageJob
One per image within an order. Key fields: `id`, `orderId`, `inputImageUrl`, `outputImageUrl`, `cutoutUrl`, `style`, `pipeline` (JobPipeline enum), `status` (JobStatus enum), `qaScore`, `attempts`, `maxAttempts` (default 3), `durationMs`.

JobPipeline values: `primary`, `fallback`, `kontext`, `segmentation`, `bria`, `nano_banana`, `composite`.

JobStatus values: `queued`, `processing`, `completed`, `failed`.

### ProcessedMessage
Idempotency table. Key field: `messageId` (primary key). Created atomically when a WhatsApp message is first processed. P2002 unique constraint violation = duplicate.

### WebhookEvent
Audit log. All inbound webhooks stored here (source: `whatsapp` | `razorpay`).

### PromptTemplate
A/B testing store. Fields: `styleId`, `version`, `prompt`, `negativePrompt`, `categoryOverrides` (JSON), `avgQaScore`, `usageCount`, `active`. Unique on `(styleId, version)`.

---

## Supabase Storage Buckets

Defined in `packages/storage/src/buckets.ts`:

| Constant | Bucket Name | Contents |
|---|---|---|
| `Buckets.RAW_IMAGES` | `raw-images` | Original user photos (downloaded from WhatsApp) |
| `Buckets.PROCESSED_IMAGES` | `processed-images` | AI output images, cutouts, videos |
| `Buckets.VOICE_NOTES` | `voice-notes` | User voice note audio files |
| `Buckets.CUTOUTS` | `cutouts` | Product cutout PNGs (also stored in processed-images) |
| `Buckets.VIDEOS` | `videos` | Ken Burns video outputs |

---

## BullMQ Queues

Defined in `packages/queue/src/names.ts`:

| Constant | Queue Name | Worker Concurrency | Purpose |
|---|---|---|---|
| `QueueNames.IMAGE_PROCESSING` | `image-processing` | 3 | AI pipeline jobs. `lockDuration: 600000` (10 min). Rate limited: 10 jobs/60s. |
| `QueueNames.PAYMENT_CHECK` | `payment-check` | 5 | Poll Razorpay after 2 min to catch missed webhooks |
| `QueueNames.SESSION_TIMEOUT` | `session-timeout` | 10 | `advance_photos` events: 45s photo batch timer, 30s post-button timer |

Queue accessors: `getImageQueue()`, `getPaymentCheckQueue()`, `getSessionTimeoutQueue()` from `@whatsads/queue`.

---

## Environment Variables

From `.env.example` at repo root:

```
# WhatsApp Cloud API (Meta)
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=          # Used for HMAC webhook signature verification

# fal.ai (BiRefNet, Flux, Seedream, Bria, ESRGAN, CodeFormer)
FAL_KEY=                      # Also checked as FAL_API_KEY

# Google AI
GOOGLE_AI_API_KEY=            # Also checked as GOOGLE_GENAI_API_KEY

# Groq (voice transcription)
GROQ_API_KEY=

# Sarvam AI (Hindi transcription fallback)
SARVAM_API_KEY=

# Razorpay
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
DATABASE_URL=                 # Pooled connection (pgBouncer)
DIRECT_URL=                   # Direct connection (for migrations)

# Redis (Upstash)
REDIS_URL=

# Admin
ADMIN_SECRET=                 # Required in production — protects /admin/* routes

# App
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
APP_URL=http://localhost:3000

# PAYMENT_BYPASS=true         # NEVER commit. Shell-export only for local dev.
```

**Dev behavior:** When `WHATSAPP_APP_SECRET` is the literal string `'placeholder'`, webhook signature verification is skipped with a warning. When `NODE_ENV !== 'production'`, most secrets accept `'placeholder'` via `optionalInDev()` in `apps/api/src/config.ts`.

**Safety guard:** If `PAYMENT_BYPASS=true` is detected at startup in production, both the API and worker call `process.exit(1)` immediately.

---

## Development Commands

```bash
# Run both API and worker in watch mode
pnpm dev

# Run individually
pnpm dev:api
pnpm dev:worker

# Build everything (db first, then rest)
pnpm build

# Type-check all packages
pnpm typecheck

# Database
pnpm db:generate    # Regenerate Prisma client after schema changes
pnpm db:migrate     # Run migrations (production)
pnpm db:push        # Push schema to dev DB without migration file
pnpm db:studio      # Open Prisma Studio GUI

# Clean all build artifacts and node_modules
pnpm clean
```

**Queue monitoring UI:** Bull Board is mounted at `/admin/queues` on the API server. Requires `ADMIN_SECRET` header in production.

---

## Pricing Constants

All defined in `packages/session/src/types.ts`:

| Constant | Value | Meaning |
|---|---|---|
| `PRICE_PER_IMAGE_PAISE` | `9900` | Rs 99 per image |
| `EDIT_REVISION_PAISE` | `2900` | Rs 29 per paid revision |
| `MAX_IMAGES_PER_ORDER` | `5` | Max photos per order |
| `FREE_REVISIONS_PER_ORDER` | `2` | Free edits included |
| `PHOTO_BATCH_TIMEOUT_SECONDS` | `45` | Time before showing Process/Instructions buttons |
| `BUTTONS_SHOWN_TIMEOUT_SECONDS` | `30` | Time after buttons shown before auto-advancing |
| `PAYMENT_CHECK_DELAY_MS` | `120_000` | 2 minutes before polling Razorpay |

Free trial: if `user.orderCount === 0`, order is created with `amount = 0` and bypasses payment.

---

## Coding Conventions

### Logging Format

Structured JSON logs everywhere in the pipeline. Worker uses `console.log(JSON.stringify({...}))`. Session handlers use the `logger` object from `packages/session/src/logger.ts`. API uses Fastify's built-in pino logger (`app.log.info()`).

Pattern in pipelines:
```typescript
console.info(JSON.stringify({ event: 'event_name', key: value, ... }));
console.error(JSON.stringify({ event: 'error_name', error: err instanceof Error ? err.message : String(err) }));
```

### Bilingual Messages

All user-facing messages are bilingual. Every message function takes `lang: 'hi' | 'en'` as its first parameter. Hindi is the default. Examples live in `packages/session/src/messages.ts`.

Pattern:
```typescript
function msgSomething(lang: 'hi' | 'en'): string {
  if (lang === 'hi') return 'Hindi text';
  return 'English text';
}
```

### Handler Structure

Every session handler has this signature:
```typescript
export async function handleStateName(
  session: Session,
  user: User,
  message: MessageContext,
  wa: WhatsAppClient,
): Promise<void>
```

Handlers are pure functions — they do not throw to the caller (errors are caught in `machine.ts`). All state transitions go through `transitionTo()`.

### Interactive Message Fallbacks

Every `wa.sendButtons()` and `wa.sendList()` call is wrapped in try/catch with a plain `wa.sendText()` fallback. WhatsApp interactive messages fail silently on some older clients.

### Error Handling in Worker

Workers re-throw errors after cleanup so BullMQ handles retries (`throw err` at the end of the catch block). `ImageJob.maxAttempts` defaults to 3.

### Import Style

All packages use ESM (`"type": "module"`). Internal imports use `.js` extensions (TypeScript resolves `.ts` at compile time). No `require()`.

---

## How to Add New Things

### New AI Pipeline

1. Create `packages/ai/src/pipeline/my-pipeline.ts` with a function `processMyPipeline(params: ProcessImageParams): Promise<ProcessImageResult>`.
2. Export it from `packages/ai/src/index.ts`.
3. Add it to the tier hierarchy in `never-fail-pipeline.ts` or call it conditionally from `gemini-pipeline-v3.ts`.
4. Add a `JobPipeline` enum value in `packages/db/prisma/schema.prisma` and run `pnpm db:generate`.
5. Map the new pipeline name in `PIPELINE_ENUM_MAP` in `apps/worker/src/processors/image-processing.ts`.

### New Session State

1. Add the state to `CONVERSATION_STATES` in `packages/session/src/types.ts`.
2. Add to `SessionState` enum in `packages/db/prisma/schema.prisma` and run `pnpm db:migrate`.
3. Create a handler file `packages/session/src/handlers/my-state.ts` with the standard handler signature.
4. Import and add a `case` in the `switch(session.state)` in `packages/session/src/machine.ts`.
5. Call `transitionTo(phoneNumber, 'MY_STATE')` from the preceding handler.

### New Message Template

1. Add a function to `packages/session/src/messages.ts` — bilingual, takes `lang: 'hi' | 'en'` as first arg.
2. Import and call from the relevant handler.
3. Do not add inline strings in handlers — all user-facing text belongs in `messages.ts`.

### New Button/List ID

1. Add to `ButtonIds` or `ListIds` in `packages/session/src/types.ts`.
2. Handle the new ID in the appropriate handler's `if (message.buttonReplyId === ...)` or `if (message.listReplyId === ...)` branch.

### New BullMQ Job Type

1. Add a Zod schema in `packages/queue/src/jobs.ts`.
2. Export type and schema from `packages/queue/src/index.ts`.
3. Add queue name to `QueueNames` in `packages/queue/src/names.ts`.
4. Add `getMyQueue()` accessor in `packages/queue/src/queues.ts`.
5. Create processor in `apps/worker/src/processors/my-processor.ts`.
6. Register `new Worker(QueueNames.MY_QUEUE, myProcessor, { ... })` in `apps/worker/src/index.ts`.

---

## Critical Constraints — NEVER Violate These

1. **Idempotency check FIRST.** `checkAndMarkProcessed(message.messageId)` must be the first thing `handleIncomingMessage` does. If you add code before it, duplicate-message bugs appear.

2. **Always respond 200 to Meta immediately.** The webhook handler calls `reply.code(200).send('OK')` before any database work. Meta has a 20-second timeout. All processing runs after the response is sent.

3. **HMAC signature must be verified in production.** The `verifyWebhookSignature()` check only skips when `WHATSAPP_APP_SECRET === 'placeholder'` and `NODE_ENV !== 'production'`. Never skip it in production.

4. **PAYMENT_BYPASS must never be set in production.** Both `apps/api/src/index.ts` and `apps/worker/src/index.ts` call `process.exit(1)` if this is detected. This is intentional.

5. **Never deliver an order that is already completed.** The worker uses an optimistic lock: `prisma.order.updateMany({ where: { id, status: { in: ['processing', 'payment_confirmed'] } } })`. If `updated.count === 0`, another worker instance already delivered — return early without sending a second image.

6. **transitionTo() is the only valid way to change session state.** Never write `prisma.session.update({ data: { state: '...' } })` directly from a handler. Always use `transitionTo()` — it sets `stateEnteredAt` and is the single source of truth.

7. **CSW window must be maintained.** `cswExpiresAt = Date.now() + 24h` is set on every inbound message in `machine.ts`. Do not remove this — it tracks when the user last messaged so the bot knows it's within the WhatsApp 24h service window.

8. **Download WhatsApp media immediately.** WhatsApp media URLs expire in 5 minutes. `handleAwaitingPhoto` downloads and uploads to Supabase on receipt, before any timer fires.

9. **advanceToPayment() has its own guard.** It re-reads the session and checks `state === 'AWAITING_PHOTO'` before creating an order. The `earlyPhotoMediaId` flag is set to `'order_creating'` before the Razorpay call to block concurrent timeout jobs from triggering duplicate orders.

10. **`session.earlyPhotoMediaId` is a multipurpose flag.** It is used both as an actual media ID (when storing an early photo from IDLE) and as a state flag (`'awaiting_action'`, `'awaiting_instructions'`, `'order_creating'`). Do not rename this field without updating all the guards in `images.ts`.

---

## Common Debugging Patterns

### Stuck Session

A user can't get a response. Steps:
1. Check `session.state` in DB: `SELECT state, state_entered_at FROM sessions WHERE phone_number = '+91...'`
2. If `PROCESSING` and `state_entered_at` is >10 min ago — the auto-recovery in `machine.ts` will reset it on next message. You can also manually set `state = 'IDLE'`.
3. If `PROCESSING` and recent — check the BullMQ job via Bull Board at `/admin/queues`. Look for failed jobs under `image-processing`.
4. If `AWAITING_PAYMENT` — check if the Razorpay payment link was created (`order.razorpay_payment_link_url`). The PAYMENT_CHECK job fires at +2min and polls Razorpay.

### Pipeline Failure

Check worker logs. Every event is logged as `JSON.stringify({ event: '...', ... })`. Key events to trace:
- `never_fail_tier1_start` / `never_fail_tier1_failed` (with `reason`)
- `pipeline_routed` (shows `track`, `hasBranding`, `brandingConfidence`)
- `qa_result` (shows `score`, `pass`, `hasFundamentalError`, `issues`)
- `fallback_bria_start` / `ultimate_fallback_studio_shot`

The never-fail pipeline guarantees a result — if Tier 1 through Tier 3 all fail, Tier 4 delivers the preprocessed original. So "no output" in the worker is only possible if the image cannot be downloaded.

### Webhook Not Arriving

1. Confirm Meta webhook subscription is active and the `WHATSAPP_VERIFY_TOKEN` matches.
2. Check `webhook_events` table — raw payloads are stored before any processing.
3. In production, check that `X-Hub-Signature-256` header is present. The `WHATSAPP_APP_SECRET` must match the app secret in Meta Business Manager.

### Duplicate Orders

If an order is delivered twice, look for the optimistic lock log: `"Order already completed by another worker, skipping delivery"`. This should appear in one of the two competing workers. If both show "delivering", the `updateMany` guard was bypassed — check that the `status` field is being set to `'processing'` when the job starts.

---

## Current Work in Progress

Based on modified files in `git status` (branch: `main`):

**AI Pipeline (all modified):**
- `packages/ai/src/pipeline/orchestrator.ts` — V3 pipeline routing logic (Track A/B/S selection, branding confidence threshold, inpainting path)
- `packages/ai/src/pipeline/fallback.ts` — Post-processing presets, BiRefNet/Flux/Seedream model calls, `STYLE_POST_CONFIG` per-style tuning
- `packages/ai/src/pipeline/gemini-pipeline-v3.ts` — V3 creative pipeline: 3 parallel candidates, border detection/auto-crop, `MAX_GENERATION_ATTEMPTS = 4`
- `packages/ai/src/pipeline/styled-studio.ts` — Tier 2 fallback: `STUDIO_COLOR_POOL` randomization, styled/clean/enhanced original tiers
- `packages/ai/src/pipeline/product-analyzer-v3.ts` — V3 analysis schema: physical size, dimensionality, canvas fill recommendation, branding confidence

**QA (both modified):**
- `packages/ai/src/qa/combined-qa.ts` — Scoring prompt updates, fidelity thresholds, fundamental error detection rules
- `packages/ai/src/qa/focused-checks.ts` — Fast binary Gemini checks, `TIMEOUT_MS = 15_000`

**Session handlers (all modified):**
- `packages/session/src/machine.ts` — Escape intent detection, PROCESSING/EDIT_PROCESSING auto-recovery timeouts
- `packages/session/src/messages.ts` — Message template updates
- `packages/session/src/handlers/onboarding.ts` — Early photo capture in IDLE, returning user flow
- `packages/session/src/handlers/images.ts` — Photo batch timer logic, `earlyPhotoMediaId` flag states, voice note instructions flow
- `packages/session/src/handlers/delivery.ts` — Feedback loop, `sendProcessedImages`, Ken Burns video delivery
- `packages/session/src/handlers/style.ts` — Style-change edit path, style resolution from typed text
- `packages/session/src/handlers/instructions.ts` — Order creation and payment link generation

**Webhook:**
- `apps/api/src/routes/webhooks/whatsapp.ts` — Rate limiter cleanup, signature verification dev/prod split
- `apps/worker/src/processors/image-processing.ts` — Never-fail result handling, PIPELINE_ENUM_MAP, video delivery
