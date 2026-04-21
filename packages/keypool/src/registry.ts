/**
 * Process-wide singleton registry of KeyPool instances, one per provider.
 *
 * Lazily materializes on first access. Emits a boot-time summary log on init
 * listing counts per provider (never the keys themselves).
 */

import { readKeysFromEnv } from './env.js';
import { KeyPool } from './pool.js';
import type { KeyPoolConfig, KeyPoolEvent, Provider, ProviderHealth } from './types.js';

let registry: Map<Provider, KeyPool> | null = null;
let eventSink: ((event: KeyPoolEvent) => void) | undefined;

/** Default event sink — structured JSON to stdout. Keys never included. */
function defaultEventSink(event: KeyPoolEvent): void {
  // Use console.info; the rest of the codebase logs JSON via console too.
  // 'acquired' is high-volume — demote to debug if LOG_LEVEL!==debug.
  const logLevel = process.env['LOG_LEVEL'] ?? 'info';
  if (event.type === 'acquired' && logLevel !== 'debug') return;
  if (event.type === 'released_success' && logLevel !== 'debug') return;
  console.info(JSON.stringify({ event: `keypool.${event.type}`, ...event }));
}

/** Override the default event sink. Call before any pool is touched. */
export function setKeyPoolEventSink(sink: (event: KeyPoolEvent) => void): void {
  eventSink = sink;
}

function buildRegistry(extraConfig?: KeyPoolConfig): Map<Provider, KeyPool> {
  const providers: Provider[] = ['gemini', 'fal', 'groq', 'sarvam', 'openai'];
  const map = new Map<Provider, KeyPool>();
  const onEvent = eventSink ?? defaultEventSink;

  const summary: Record<string, number> = {};
  for (const provider of providers) {
    const keys = readKeysFromEnv(provider);
    if (keys.length === 0) {
      summary[provider] = 0;
      continue;
    }
    const pool = new KeyPool(provider, keys, { ...extraConfig, onEvent });
    map.set(provider, pool);
    summary[provider] = keys.length;
  }

  console.info(JSON.stringify({ event: 'keypool.boot_summary', providers: summary }));
  return map;
}

export function getKeyPool(provider: Provider): KeyPool {
  if (!registry) registry = buildRegistry();
  const pool = registry.get(provider);
  if (!pool) {
    throw new Error(
      `[keypool] ${provider}: no keys configured — set env var (see packages/keypool/src/env.ts)`,
    );
  }
  return pool;
}

export function hasKeyPool(provider: Provider): boolean {
  if (!registry) registry = buildRegistry();
  return registry.has(provider);
}

export function allHealth(): Record<Provider, ProviderHealth | null> {
  if (!registry) registry = buildRegistry();
  const out: Record<Provider, ProviderHealth | null> = {
    gemini: null,
    fal: null,
    groq: null,
    sarvam: null,
    openai: null,
  };
  for (const provider of ['gemini', 'fal', 'groq', 'sarvam', 'openai'] as Provider[]) {
    const pool = registry.get(provider);
    out[provider] = pool ? pool.health() : null;
  }
  return out;
}

/**
 * Synchronous single-shot key accessor for a provider.
 * Rotates round-robin, skips cool-down keys. For Autmn's existing
 * AI call sites that pull the key inline and aren't easily refactored
 * to acquire/release lifecycles.
 *
 * Pair with `reportProviderResult()` in the caller's catch/finally to
 * give the pool health attribution. If never reported, the pool still
 * rotates across calls — just without fine-grained health tracking.
 */
export function getProviderKey(provider: Provider): string {
  return getKeyPool(provider).getKeySync();
}

/**
 * Report the outcome of the most-recent `getProviderKey(provider)` call.
 * Best-effort — accurate when handlers are single-request-scoped (Autmn's
 * worker processor model is).
 */
export function reportProviderResult(
  provider: Provider,
  outcome: { success: true } | { success: false; errorCode?: number | string },
): void {
  getKeyPool(provider).reportLastOutcome(outcome);
}

/** Manual health override. Returns true if a key was revived. */
export function reviveKey(provider: Provider, hint: string): boolean {
  if (!registry) registry = buildRegistry();
  const pool = registry.get(provider);
  if (!pool) return false;
  return pool.revive(hint);
}

/** Test-only: drop the singleton so a fresh process env can be re-read. */
export function __resetRegistryForTests(): void {
  registry = null;
  eventSink = undefined;
}
