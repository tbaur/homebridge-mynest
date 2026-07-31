/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Backoff and retry helpers.
 */

import { NestError, RateLimitError } from '../errors'
import { MAX_REQUEST_ATTEMPTS, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from '../settings'

/** Awaitable delay. Exported so tests can substitute it and skip real waits. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not decoration. Every Homebridge instance running this plugin
 * reconnects against the same Nest gateway, and an outage that ends with all
 * of them retrying on the same schedule is how a recovering service is knocked
 * back over.
 *
 * @param attempt 1-based attempt number.
 * @param random Injectable for deterministic tests.
 */
export function computeBackoffMs(
  attempt: number,
  baseMs: number = RECONNECT_BASE_MS,
  maxMs: number = RECONNECT_MAX_MS,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
  // Full jitter over [base, exponential] rather than [0, exponential]: waiting
  // near-zero after a failure is just an immediate retry with extra steps.
  const floor = Math.min(baseMs, exponential)
  return Math.round(floor + random() * (exponential - floor))
}

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Decides whether a given failure is worth another attempt. */
  isRetryable?: (error: unknown) => boolean
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void
}

const defaultIsRetryable = (error: unknown): boolean =>
  error instanceof NestError && error.isRetryable

/**
 * Run an operation, retrying retryable failures with backoff.
 *
 * A server-supplied `Retry-After` always wins over computed backoff: Nest
 * telling the client how long to wait is better information than a guess.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? MAX_REQUEST_ATTEMPTS
  const isRetryable = options.isRetryable ?? defaultIsRetryable
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error

      if (!isRetryable(error) || attempt === maxAttempts) {
        throw error
      }

      const serverDelay = error instanceof RateLimitError ? error.retryAfterMs : undefined
      const delayMs = serverDelay
        ?? computeBackoffMs(attempt, options.baseDelayMs, options.maxDelayMs)

      options.onRetry?.(attempt, delayMs, error)
      await sleep(delayMs)
    }
  }

  throw lastError
}
