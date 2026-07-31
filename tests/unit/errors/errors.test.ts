/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The error hierarchy the run loops branch on.
 *
 * Whether a failure is retryable decides whether the plugin backs off and
 * carries on or stops and tells the user, so the classification is behaviour
 * rather than metadata.
 */

import {
  ApiParseError,
  ApiResponseError,
  AuthenticationError,
  CircuitBreakerError,
  ConfigurationError,
  ForbiddenError,
  NestError,
  NetworkError,
  ObserveStreamError,
  RateLimitError,
  SessionShapeError,
  TimeoutError,
  createApiError,
  isAbortError,
  isCircuitBreakerFailure,
  parseRetryAfterMs,
} from '../../../src/errors'

describe('the error hierarchy', () => {
  it('derives every error from NestError with a usable name', () => {
    const errors = [
      new ConfigurationError('bad config'),
      new AuthenticationError('rejected'),
      new ForbiddenError('forbidden'),
      new SessionShapeError(['userid']),
      new NetworkError('unreachable'),
      new TimeoutError('too slow'),
      new RateLimitError('slow down'),
      new ApiResponseError(500, 'server error'),
      new ApiParseError('not JSON'),
      new ObserveStreamError('stream reset'),
      new CircuitBreakerError(5_000),
    ]

    for (const error of errors) {
      expect(error).toBeInstanceOf(NestError)
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe(error.constructor.name)
      expect(error.stack).toBeDefined()
    }
  })

  it('marks the failures worth retrying', () => {
    expect(new NetworkError('unreachable').isRetryable).toBe(true)
    expect(new TimeoutError('too slow').isRetryable).toBe(true)
    expect(new RateLimitError('slow down').isRetryable).toBe(true)
    expect(new ForbiddenError('forbidden').isRetryable).toBe(true)
    expect(new ObserveStreamError('stream reset').isRetryable).toBe(true)
    expect(new ApiResponseError(500, 'server error').isRetryable).toBe(true)
    // An unparseable body is usually an HTML page from Nest's edge during a
    // blip, which the next request gets past.
    expect(new ApiParseError('not JSON').isRetryable).toBe(true)
  })

  it('marks the failures that retrying cannot fix', () => {
    // Retrying a token Nest has refused only produces the same refusal.
    expect(new AuthenticationError('rejected').isRetryable).toBe(false)
    expect(new ConfigurationError('bad config').isRetryable).toBe(false)
    expect(new SessionShapeError(['userid']).isRetryable).toBe(false)
    expect(new CircuitBreakerError(5_000).isRetryable).toBe(false)
  })

  it('CircuitBreakerError carries CIRCUIT_OPEN and retry timing', () => {
    jest.useFakeTimers()
    const err = new CircuitBreakerError(12_000)
    expect(err.code).toBe('CIRCUIT_OPEN')
    expect(err.retryAfterMs).toBe(12_000)
    jest.useRealTimers()
  })

  it('classifies which failures trip a transport breaker', () => {
    expect(isCircuitBreakerFailure(new NetworkError('down'))).toBe(true)
    expect(isCircuitBreakerFailure(new TimeoutError('slow'))).toBe(true)
    expect(isCircuitBreakerFailure(new ApiParseError('html'))).toBe(true)
    expect(isCircuitBreakerFailure(new ObserveStreamError('reset'))).toBe(true)
    expect(isCircuitBreakerFailure(new ApiResponseError(503, 'unavailable'))).toBe(true)

    expect(isCircuitBreakerFailure(new ApiResponseError(400, 'bad'))).toBe(false)
    expect(isCircuitBreakerFailure(new AuthenticationError())).toBe(false)
    expect(isCircuitBreakerFailure(new ForbiddenError('waf'))).toBe(false)
    expect(isCircuitBreakerFailure(new RateLimitError('slow'))).toBe(false)
    expect(isCircuitBreakerFailure(new CircuitBreakerError(1_000))).toBe(false)
  })

  it('keeps the original failure as the cause', () => {
    const cause = new Error('ECONNRESET')

    expect(new NetworkError('unreachable', { cause }).cause).toBe(cause)
  })

  it('names every missing session field', () => {
    expect(new SessionShapeError(['userid', 'urls.transport_url']).message)
      .toContain('userid, urls.transport_url')
  })
})

describe('createApiError', () => {
  it.each([
    [401, AuthenticationError],
    [403, ForbiddenError],
    [429, RateLimitError],
    [500, ApiResponseError],
    [503, ApiResponseError],
    [400, ApiResponseError],
  ])('maps HTTP %i to the right error', (status, expected) => {
    expect(createApiError(status, `HTTP ${status}`)).toBeInstanceOf(expected)
  })

  it('treats a server error as retryable and a client error as not', () => {
    expect(createApiError(503, 'unavailable').isRetryable).toBe(true)
    expect(createApiError(400, 'bad request').isRetryable).toBe(false)
  })

  it('carries the retry delay onto a rate limit', () => {
    const error = createApiError(429, 'slow down', { retryAfterMs: 5000 })

    expect((error as RateLimitError).retryAfterMs).toBe(5000)
  })
})

describe('parseRetryAfterMs', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000)
  })

  it('reads an HTTP date', () => {
    const future = new Date(Date.now() + 60_000).toUTCString()
    const parsed = parseRetryAfterMs(future)

    expect(parsed).toBeGreaterThan(30_000)
    expect(parsed).toBeLessThanOrEqual(60_000)
  })

  it('treats a date already past as no delay', () => {
    expect(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBe(0)
  })

  it('ignores a header it cannot read', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined()
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs('')).toBeUndefined()
    expect(parseRetryAfterMs('soon')).toBeUndefined()
    expect(parseRetryAfterMs('-5')).toBeUndefined()
  })
})

describe('isAbortError', () => {
  it('recognises an abort however it was raised', () => {
    const named = new Error('aborted')
    named.name = 'AbortError'

    expect(isAbortError(named)).toBe(true)
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true)
  })

  it('does not mistake an ordinary failure for an abort', () => {
    expect(isAbortError(new Error('connection reset'))).toBe(false)
    expect(isAbortError('aborted')).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
  })
})
