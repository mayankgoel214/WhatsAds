/**
 * Simple in-memory circuit breaker for Gemini image generation.
 * Trips after consecutive failures, auto-recovers after cooldown.
 *
 * States:
 * - CLOSED: Normal operation, requests go through
 * - OPEN: Too many failures, fast-fail all requests
 * - HALF_OPEN: Cooldown expired, allow one probe request
 */

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerConfig {
  failureThreshold: number;  // consecutive failures to trip
  cooldownMs: number;        // how long to stay OPEN before trying again
  name: string;              // for logging
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
  name: 'gemini-image',
};

class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  isOpen(): boolean {
    if (this.state === 'CLOSED') return false;
    if (this.state === 'OPEN') {
      // Check if cooldown has passed
      if (Date.now() - this.openedAt >= this.config.cooldownMs) {
        this.state = 'HALF_OPEN';
        console.info(JSON.stringify({ event: 'circuit_breaker_half_open', name: this.config.name }));
        return false; // Allow one probe request
      }
      return true; // Still in cooldown
    }
    // HALF_OPEN — allow the probe
    return false;
  }

  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      console.info(JSON.stringify({ event: 'circuit_breaker_closed', name: this.config.name }));
    }
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.state === 'HALF_OPEN') {
      // Probe failed — back to OPEN
      this.state = 'OPEN';
      this.openedAt = Date.now();
      console.warn(JSON.stringify({ event: 'circuit_breaker_reopened', name: this.config.name, failures: this.consecutiveFailures }));
      return;
    }
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      this.consecutiveFailures = 0;
      console.warn(JSON.stringify({ event: 'circuit_breaker_opened', name: this.config.name, cooldownMs: this.config.cooldownMs }));
    }
  }

  getState(): CircuitState { return this.state; }
}

// Singleton instance for Gemini image generation
export const geminiImageBreaker = new CircuitBreaker({
  failureThreshold: 5,
  cooldownMs: 60_000,
  name: 'gemini-image',
});

export { CircuitBreaker };
