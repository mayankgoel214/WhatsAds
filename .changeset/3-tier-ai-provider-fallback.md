---
"@autmn/ai": minor
"@autmn/keypool": minor
"@autmn/worker": patch
---

feat: 3-tier AI generation architecture with OpenAI provider fallback

Replaces the old BiRefNet/sharp fallback tiers with a quality-preserving 3-tier
model:

- Tier 1: gemini-3-pro-image-preview (full V5 pipeline, 2 QA attempts)
- Tier 2: gemini-3.1-flash-image-preview (same V5 code, different model)
- Tier 3: OpenAI gpt-image-1 (provider fallback when Gemini is unavailable)

All tiers run the same combinedQualityCheck gate. If all 3 fail, throws with
[needs_refund: true] marker — worker logs the event and marks the order failed
for manual refund action. BiRefNet styled-studio, clean-studio, and
enhanced-original fallbacks are removed.

Adds openai provider to @autmn/keypool (OPENAI_API_KEY / OPENAI_API_KEYS env vars).
Adds model override param to geminiGenerateImage() and processProductImageV5()
so Tier 1 vs Tier 2 differ only by the model string.
