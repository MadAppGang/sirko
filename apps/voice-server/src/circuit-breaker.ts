/**
 * CircuitBreaker — three-state circuit breaker per external API.
 *
 * States:
 *   closed   → normal operation; failure count tracked
 *   open     → calls rejected immediately; probe after probeAfterMs
 *   half-open → a single probe call is allowed; success closes, failure re-opens
 */

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerOptions {
  /** Number of failures within the window that trips the breaker. Default: 3 */
  failureThreshold?: number
  /** Window in ms for counting failures. Default: 30_000 */
  windowMs?: number
  /** Time in ms before probing after open. Default: 60_000 */
  probeAfterMs?: number
  /** Name for error messages. Default: 'circuit' */
  name?: string
}

export class CircuitBreakerOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker '${name}' is open`)
    this.name = 'CircuitBreakerOpenError'
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failures: number[] = []
  private openedAt: number | null = null
  private probeInFlight = false

  private readonly failureThreshold: number
  private readonly windowMs: number
  private readonly probeAfterMs: number
  private readonly name: string

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3
    this.windowMs = options.windowMs ?? 30_000
    this.probeAfterMs = options.probeAfterMs ?? 60_000
    this.name = options.name ?? 'circuit'
  }

  get currentState(): CircuitState {
    return this.state
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.pruneFailures()

    if (this.state === 'open') {
      const elapsed = Date.now() - (this.openedAt ?? 0)
      if (elapsed >= this.probeAfterMs && !this.probeInFlight) {
        // Transition to half-open and allow a probe
        this.state = 'half-open'
        this.probeInFlight = true
      } else {
        throw new CircuitBreakerOpenError(this.name)
      }
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err) {
      this.onFailure()
      throw err
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed'
      this.failures = []
      this.openedAt = null
    }
    this.probeInFlight = false
  }

  private onFailure(): void {
    this.probeInFlight = false
    const now = Date.now()
    this.failures.push(now)
    this.pruneFailures()

    if (this.state === 'half-open' || this.failures.length >= this.failureThreshold) {
      this.state = 'open'
      this.openedAt = now
      this.failures = []
    }
  }

  private pruneFailures(): void {
    const cutoff = Date.now() - this.windowMs
    this.failures = this.failures.filter((t) => t > cutoff)
  }

  /** Reset to closed (for testing or manual recovery). */
  reset(): void {
    this.state = 'closed'
    this.failures = []
    this.openedAt = null
    this.probeInFlight = false
  }
}
