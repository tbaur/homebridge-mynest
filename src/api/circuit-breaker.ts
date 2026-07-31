/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Circuit breaker for Nest API resilience.
 *
 * When Nest's edge is failing hard (5xx storms, network black holes), hammering
 * it from every install only prolongs the outage and burns battery on the
 * Homebridge host. Failing fast for a short cooldown lets the dual transport
 * loops back off cleanly and probe again when the service may have recovered.
 */

import { CircuitBreakerError } from '../errors'

/** Circuit breaker states. */
export enum CircuitState {
  /** Normal operation; requests flow through. */
  CLOSED = 'CLOSED',
  /** Tripped; requests fail immediately. */
  OPEN = 'OPEN',
  /** Probing whether the service recovered. */
  HALF_OPEN = 'HALF_OPEN',
}

/** Circuit breaker tuning. */
export interface CircuitBreakerConfig {
  /** Failures within the window before the circuit opens. */
  failureThreshold: number
  /** How long to stay open before probing again, in ms. */
  resetTimeoutMs: number
  /** Consecutive successes needed to close from half-open. */
  halfOpenMax: number
  /** Sliding window over which failures are counted, in ms. */
  failureWindowMs: number
  /** Called on every state transition, for observability. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void
}

/**
 * Defaults tuned for Nest's dual independent transports.
 *
 * `halfOpenMax: 1` avoids concurrent probe races when a loop retries quickly.
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMax: 1,
  failureWindowMs: 60_000,
}

/** Snapshot of breaker state, for diagnostics. */
export interface CircuitBreakerStatus {
  state: CircuitState
  failures: number
  successes: number
  lastFailureTime: number | null
  isOpen: boolean
  remainingResetTimeMs: number | null
}

/** Options for {@link CircuitBreaker.execute}. */
export interface CircuitBreakerExecuteOptions {
  /**
   * Which errors count toward opening the breaker.
   *
   * Defaults to treating every thrown error as a failure. Nest callers pass a
   * filter so auth/403/rate-limit paths do not trip the breaker.
   */
  isFailure?: (error: unknown) => boolean
}

/** Circuit breaker guarding calls to one Nest transport. */
export class CircuitBreaker {
  readonly #failureThreshold: number
  readonly #resetTimeoutMs: number
  readonly #halfOpenMax: number
  readonly #failureWindowMs: number
  #onStateChange?: (from: CircuitState, to: CircuitState) => void

  #state: CircuitState = CircuitState.CLOSED
  #successes = 0
  #lastFailureTime: number | null = null
  #halfOpenRequests = 0
  #failureTimestamps: number[] = []

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    const merged = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config }
    this.#failureThreshold = merged.failureThreshold
    this.#resetTimeoutMs = merged.resetTimeoutMs
    this.#halfOpenMax = merged.halfOpenMax
    this.#failureWindowMs = merged.failureWindowMs
    this.#onStateChange = merged.onStateChange
  }

  /**
   * Chain an additional state-change listener without replacing any listener
   * already supplied at construction.
   */
  attachOnStateChange(handler: (from: CircuitState, to: CircuitState) => void): void {
    const previous = this.#onStateChange
    this.#onStateChange = (from, to) => {
      previous?.(from, to)
      handler(from, to)
    }
  }

  get state(): CircuitState {
    return this.#state
  }

  get isOpen(): boolean {
    return this.#state === CircuitState.OPEN
  }

  /** Transition state, notifying observers only on an actual change. */
  #transitionTo(next: CircuitState): void {
    if (this.#state === next) {
      return
    }
    const previous = this.#state
    this.#state = next
    this.#onStateChange?.(previous, next)
  }

  /** Drop failures that have aged out of the sliding window. */
  #pruneFailures(): void {
    const cutoff = Date.now() - this.#failureWindowMs
    this.#failureTimestamps = this.#failureTimestamps.filter((ts) => ts > cutoff)
  }

  /** Whether a request may proceed right now. */
  canRequest(): boolean {
    if (this.#state === CircuitState.CLOSED) {
      return true
    }

    if (this.#state === CircuitState.OPEN) {
      const isCooldownElapsed = this.#lastFailureTime !== null
        && Date.now() - this.#lastFailureTime >= this.#resetTimeoutMs

      if (isCooldownElapsed) {
        this.#halfOpenRequests = 0
        this.#successes = 0
        this.#transitionTo(CircuitState.HALF_OPEN)
        return true
      }
      return false
    }

    return this.#halfOpenRequests < this.#halfOpenMax
  }

  recordSuccess(): void {
    if (this.#state === CircuitState.HALF_OPEN) {
      this.#successes++
      if (this.#successes >= this.#halfOpenMax) {
        this.reset()
      }
      return
    }

    if (this.#state === CircuitState.OPEN) {
      // An in-flight request that completed after the trip proves reachability.
      this.reset()
      return
    }

    this.#pruneFailures()
  }

  recordFailure(): void {
    // Already open: ignore late failures so overlapping probes cannot keep
    // pushing lastFailureTime forward and extend the cooldown.
    if (this.#state === CircuitState.OPEN) {
      return
    }

    const now = Date.now()
    this.#lastFailureTime = now
    this.#failureTimestamps.push(now)

    if (this.#state === CircuitState.HALF_OPEN) {
      this.#halfOpenRequests = 0
      this.#successes = 0
      this.#transitionTo(CircuitState.OPEN)
      return
    }

    if (this.#state === CircuitState.CLOSED) {
      this.#pruneFailures()
      if (this.#failureTimestamps.length >= this.#failureThreshold) {
        this.#transitionTo(CircuitState.OPEN)
      }
    }
  }

  reset(): void {
    this.#successes = 0
    this.#lastFailureTime = null
    this.#halfOpenRequests = 0
    this.#failureTimestamps = []
    this.#transitionTo(CircuitState.CLOSED)
  }

  getStatus(): CircuitBreakerStatus {
    this.#pruneFailures()

    const remainingResetTimeMs = this.#state === CircuitState.OPEN && this.#lastFailureTime !== null
      ? Math.max(0, this.#resetTimeoutMs - (Date.now() - this.#lastFailureTime))
      : null

    return {
      state: this.#state,
      failures: this.#failureTimestamps.length,
      successes: this.#successes,
      lastFailureTime: this.#lastFailureTime,
      isOpen: this.isOpen,
      remainingResetTimeMs,
    }
  }

  /**
   * Run an operation under the breaker.
   *
   * @throws {CircuitBreakerError} The circuit is open.
   */
  async execute<T>(
    operation: () => Promise<T>,
    options: CircuitBreakerExecuteOptions = {},
  ): Promise<T> {
    const isFailure = options.isFailure ?? (() => true)

    if (!this.canRequest()) {
      throw new CircuitBreakerError(this.getStatus().remainingResetTimeMs ?? this.#resetTimeoutMs)
    }

    if (this.#state === CircuitState.HALF_OPEN) {
      this.#halfOpenRequests++
    }

    try {
      const result = await operation()
      this.recordSuccess()
      return result
    } catch (error) {
      const wasHalfOpen = this.#state === CircuitState.HALF_OPEN
      if (wasHalfOpen || isFailure(error)) {
        this.recordFailure()
      }
      throw error
    }
  }
}
