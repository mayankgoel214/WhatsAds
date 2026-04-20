# Changelog

All notable changes to Autmn are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/spec/v2.0.0.html).

Per-package release notes are managed via [Changesets](https://github.com/changesets/changesets) under `.changeset/`; this file is the repo-level rollup.

## [Unreleased]

### Fixed

- **AI pipeline — lightAnalyze no longer times out on multi-photo orders.** Timeout now scales by photo count (12s base + 5s per extra photo, 35s cap), and parse failures are surfaced instead of silently falling back to a `"product"` default. ([#1](https://github.com/mayankgoel214/Autmn/pull/1))
- **AI pipeline — V5 QA fidelity gate restored.** V5 now runs `combinedQualityCheck` with V3's `score ≥ 65 && productFidelityScore ≥ 25` thresholds instead of the 3-boolean `simpleQA` that let wrong-product outputs ship. Falls through to never-fail Tier 2 when both candidates miss the gate. ([#2](https://github.com/mayankgoel214/Autmn/pull/2))
- **Webhook UX — unsupported-type rejection no longer triple-fires.** Meta sends extra envelopes (reaction/system/order/referral/media-metadata) during photo uploads; each classified as `unknown` and fired the rejection text. User-facing rejection now deduped within a 10s window per phone; every unknown still emits a structured `webhook_unknown_type` log with `rawType` and non-standard `messageKeys` for debugging. ([#5](https://github.com/mayankgoel214/Autmn/pull/5))
