---
'@autmn/ai': patch
---

fix(ai): scale `lightAnalyze` timeout by photo count and surface parse failures

`lightAnalyze` had a flat 10s timeout that hit ~100% of 3-photo calls in production (Gemini multi-image vision regularly takes 8–15s). On timeout or parse error it silently returned conservative defaults (`productName:"product"`, `productCategory:"other"`), which then flowed into the Gemini generation prompt — producing wrong-product ads for any multi-photo order.

Changes:
- Scale the timeout by buffer count: `12s` base, `+5s` per extra photo, capped at `35s`.
- On timeout / `JSON.parse` failure / Zod schema failure, throw instead of returning defaults. The V5 pipeline's outer `try/catch` now decides whether to retry or continue with a blind generation.
- Log raw Gemini text (truncated to 500 chars) on parse failure as a structured `light_analyze_parse_failed` event.
- Add `hadAnalysis: boolean` to V5 telemetry so operators can tell from logs which generations ran without an analysis.

Refs: `PRODUCTION_READINESS_PLAN.md` P0-1.
