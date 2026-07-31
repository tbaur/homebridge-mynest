/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Backoff and retry behaviour.
 */

import {
  AuthenticationError,
  NetworkError,
  RateLimitError,
} from '../../../src/errors'
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS } from '../../../src/settings'
import { computeBackoffMs, sleep, withRetry } from '../../../src/utils/retry'

describe('computeBackoffMs', () => {
  it('grows with each attempt', () => {
    const noJitter = () => 1
    const delays = [1, 2, 3, 4].map((attempt) => computeBackoffMs(attempt, 1000, 60_000, noJitter))

    expect(delays).toEqual([1000, 2000, 4000, 8000])
  })

  it('never exceeds the ceiling', () => {
    expect(computeBackoffMs(50, 1000, 30_000, () => 1)).toBe(30_000)
  })

  it('never drops below the base delay', () => {
    // Full jitter over [0, exponential] would mean waiting almost no time after
    // a failure, which is an immediate retry with extra steps.
    for (const attempt of [1, 2, 5, 10]) {
      expect(computeBackoffMs(attempt, 1000, 60_000, () => 0)).toBeGreaterThanOrEqual(1000)
    }
  })

  it('spreads retries across the window', () => {
    // Every Homebridge instance reconnects against the same Nest gateway, so an
    // outage ending with all of them on the same schedule is how a recovering
    // service gets knocked back over.
    const delays = new Set(
      Array.from({ length: 50 }, () => computeBackoffMs(5, 1000, 60_000)),
    )

    expect(delays.size).toBeGreaterThan(10)
  })

  it('handles a zeroth or negative attempt without going backwards', () => {
    expect(computeBackoffMs(0, 1000, 60_000, () => 1)).toBe(1000)
    expect(computeBackoffMs(-3, 1000, 60_000, () => 1)).toBe(1000)
  })

  it('uses the plugin defaults when none are given', () => {
    const delay = computeBackoffMs(1)

    expect(delay).toBeGreaterThanOrEqual(RECONNECT_BASE_MS)
    expect(delay).toBeLessThanOrEqual(RECONNECT_MAX_MS)
  })
})

describe('sleep', () => {
  it('resolves after the requested delay', async () => {
    const start = Date.now()
    await sleep(20)

    expect(Date.now() - start).toBeGreaterThanOrEqual(15)
  })
})

describe('withRetry', () => {
  it('returns the first successful result', async () => {
    const operation = jest.fn().mockResolvedValue('ok')

    await expect(withRetry(operation)).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('retries a retryable failure and succeeds', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new NetworkError('connection reset'))
      .mockResolvedValue('ok')

    await expect(withRetry(operation, { baseDelayMs: 1, maxDelayMs: 2 })).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('gives up immediately on a rejected token', async () => {
    // Retrying a credential Nest has refused only produces the same refusal.
    const operation = jest.fn().mockRejectedValue(new AuthenticationError('token rejected'))

    await expect(withRetry(operation, { baseDelayMs: 1 })).rejects.toThrow(AuthenticationError)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('stops after the attempt limit and reports the last failure', async () => {
    const operation = jest.fn().mockRejectedValue(new NetworkError('still down'))

    await expect(withRetry(operation, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }))
      .rejects.toThrow('still down')
    expect(operation).toHaveBeenCalledTimes(3)
  })

  it('honours a Retry-After over its own backoff', async () => {
    // Nest saying how long to wait is better information than a guess.
    const delays: number[] = []
    const operation = jest.fn()
      .mockRejectedValueOnce(new RateLimitError('slow down', { retryAfterMs: 5 }))
      .mockResolvedValue('ok')

    await withRetry(operation, {
      baseDelayMs: 10_000,
      onRetry: (_attempt, delayMs) => delays.push(delayMs),
    })

    expect(delays).toEqual([5])
  })

  it('reports each retry to the caller', async () => {
    const onRetry = jest.fn()
    const operation = jest.fn()
      .mockRejectedValueOnce(new NetworkError('flaky'))
      .mockResolvedValue('ok')

    await withRetry(operation, { baseDelayMs: 1, maxDelayMs: 2, onRetry })

    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number), expect.any(NetworkError))
  })

  it('lets the caller decide what is retryable', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new Error('plain error'))
      .mockResolvedValue('ok')

    await expect(withRetry(operation, { baseDelayMs: 1, isRetryable: () => true }))
      .resolves.toBe('ok')
  })

  it('does not retry an error it was never told about', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('unknown failure'))

    await expect(withRetry(operation, { baseDelayMs: 1 })).rejects.toThrow('unknown failure')
    expect(operation).toHaveBeenCalledTimes(1)
  })
})
