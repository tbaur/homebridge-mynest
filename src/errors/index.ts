/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Structured error hierarchy for predictable error handling.
 */

/**
 * Base class for all plugin errors.
 *
 * Carries a stable machine-readable `code` and an `isRetryable` hint so callers
 * can make retry decisions without string-matching messages — which matters
 * here because Nest's error text is inconsistent and unversioned.
 */
export abstract class NestError extends Error {
  abstract readonly code: string
  abstract readonly isRetryable: boolean
  readonly httpStatus?: number
  readonly timestamp: Date

  constructor(message: string, options?: { cause?: Error }) {
    super(message, options)
    this.name = this.constructor.name
    this.timestamp = new Date()
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      isRetryable: this.isRetryable,
      httpStatus: this.httpStatus,
      timestamp: this.timestamp.toISOString(),
    }
  }
}

/** Configuration is missing or invalid; not recoverable without user action. */
export class ConfigurationError extends NestError {
  readonly code = 'CONFIG_ERROR'
  readonly isRetryable = false
}

/**
 * Nest rejected the access token (HTTP 401).
 *
 * Not retryable: the token is copied by hand from a browser session and only a
 * new one will help. Retrying a rejected token is also how an account attracts
 * attention it does not want.
 */
export class AuthenticationError extends NestError {
  readonly code = 'AUTH_ERROR'
  readonly isRetryable = false
  override readonly httpStatus = 401

  constructor(
    message = 'Nest rejected the configured access token. Sign in at https://home.nest.com, open https://home.nest.com/session, and copy a fresh "access_token".',
    options?: { cause?: Error },
  ) {
    super(message, options)
  }
}

/**
 * Nest answered HTTP 403 Forbidden.
 *
 * Retryable with backoff: on the per-account transport host a 403 can be a WAF
 * or bot-detection blip against the pinned browser user agent, not a dead
 * token. The transport escalates to fatal only after several consecutive 403s.
 */
export class ForbiddenError extends NestError {
  readonly code = 'FORBIDDEN_ERROR'
  readonly isRetryable = true
  override readonly httpStatus = 403

  constructor(message: string, options?: { cause?: Error }) {
    super(message, options)
  }
}

/**
 * The session JSON was accepted but did not carry what the plugin needs.
 *
 * Distinguished from an authentication failure because the remedy is a plugin
 * update, not a new token: it means Nest changed the shape of the response.
 */
export class SessionShapeError extends NestError {
  readonly code = 'SESSION_SHAPE_ERROR'
  readonly isRetryable = false

  constructor(missing: readonly string[], options?: { cause?: Error }) {
    super(
      `The Nest session response is missing ${missing.join(', ')}. Nest may have changed its session format; please report this.`,
      options,
    )
  }
}

/** Network-level failure (DNS, connection reset, etc.). Safe to retry. */
export class NetworkError extends NestError {
  readonly code = 'NETWORK_ERROR'
  readonly isRetryable = true
}

/** Request exceeded the configured timeout. Safe to retry. */
export class TimeoutError extends NestError {
  readonly code = 'TIMEOUT_ERROR'
  readonly isRetryable = true
}

/** Rate limited by Nest (429). Retryable with backoff. */
export class RateLimitError extends NestError {
  readonly code = 'RATE_LIMIT_ERROR'
  readonly isRetryable = true
  override readonly httpStatus = 429
  /** Server-suggested wait from `Retry-After`, when present. */
  readonly retryAfterMs?: number

  constructor(message: string, options?: { cause?: Error; retryAfterMs?: number }) {
    super(message, options?.cause ? { cause: options.cause } : undefined)
    this.retryAfterMs = options?.retryAfterMs
  }
}

/** Non-2xx response that isn't auth or rate limiting. Retryable only for 5xx. */
export class ApiResponseError extends NestError {
  readonly code = 'API_RESPONSE_ERROR'
  readonly isRetryable: boolean
  override readonly httpStatus: number

  constructor(status: number, message: string, options?: { cause?: Error }) {
    super(message, options)
    this.httpStatus = status
    this.isRetryable = status >= 500
  }
}

/**
 * Response body could not be parsed as expected.
 *
 * Usually an HTML error or interstitial served where JSON was expected, which
 * is what Nest returns when a request is refused at the edge. Retryable,
 * because a single bad payload should not permanently stop the poll loop.
 */
export class ApiParseError extends NestError {
  readonly code = 'API_PARSE_ERROR'
  readonly isRetryable = true
}

/**
 * The Observe stream failed or went silent.
 *
 * Retryable by design: this is the primary state source for thermostats, so
 * the run loop reconnects with backoff rather than giving up.
 */
export class ObserveStreamError extends NestError {
  readonly code = 'OBSERVE_STREAM_ERROR'
  readonly isRetryable = true
}

/**
 * A Nest transport circuit breaker is open.
 *
 * Not retryable inside a single logical request — the loop should wait out
 * {@link retryAfterMs} and try again on the next cycle.
 */
export class CircuitBreakerError extends NestError {
  readonly code = 'CIRCUIT_OPEN'
  readonly isRetryable = false
  readonly resetTime: Date

  constructor(resetTimeMs: number, options?: { cause?: Error }) {
    const resetTime = new Date(Date.now() + resetTimeMs)
    super(`Circuit breaker is open. Nest unavailable until ${resetTime.toISOString()}`, options)
    this.resetTime = resetTime
  }

  get retryAfterMs(): number {
    return Math.max(0, this.resetTime.getTime() - Date.now())
  }
}

/**
 * Whether a failure should count toward opening a Nest transport breaker.
 *
 * Auth, 403, and rate-limit paths have their own handling and must not trip
 * the breaker. Sustained 5xx / network / parse / Observe stream failures do.
 */
export function isCircuitBreakerFailure(error: unknown): boolean {
  if (error instanceof CircuitBreakerError) {
    return false
  }
  if (
    error instanceof AuthenticationError
    || error instanceof ForbiddenError
    || error instanceof ConfigurationError
    || error instanceof RateLimitError
    || error instanceof SessionShapeError
  ) {
    return false
  }
  if (
    error instanceof NetworkError
    || error instanceof TimeoutError
    || error instanceof ApiParseError
    || error instanceof ObserveStreamError
  ) {
    return true
  }
  if (error instanceof ApiResponseError) {
    return error.httpStatus >= 500
  }
  return false
}

/**
 * Parse an HTTP `Retry-After` value into a millisecond delay.
 *
 * Accepts either a delay in seconds or an HTTP-date. Invalid values are ignored
 * so callers fall back to computed backoff.
 */
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) {
    return undefined
  }

  const trimmed = header.trim()
  if (!trimmed) {
    return undefined
  }

  // Anything numeric is settled here rather than falling through to the date
  // branch, where `Date.parse` reads "-5" as a year and turns a nonsensical
  // delay into "retry immediately".
  const asSeconds = Number(trimmed)
  if (Number.isFinite(asSeconds)) {
    return asSeconds >= 0 ? Math.round(asSeconds * 1_000) : undefined
  }

  const asDate = Date.parse(trimmed)
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now())
  }

  return undefined
}

/**
 * Map an HTTP status to the appropriate error type.
 *
 * Nest answers a bad or expired token with 401. A 403 on the transport host is
 * sometimes the same, but can also be a transient edge refusal, so it becomes
 * {@link ForbiddenError} and is only treated as fatal after repeated hits.
 */
export function createApiError(
  status: number,
  message: string,
  options?: { cause?: Error; retryAfterMs?: number },
): NestError {
  const cause = options?.cause ? { cause: options.cause } : undefined

  if (status === 401) {
    return new AuthenticationError(message, cause)
  }
  if (status === 403) {
    return new ForbiddenError(message, cause)
  }
  if (status === 429) {
    return new RateLimitError(message, {
      cause: options?.cause,
      retryAfterMs: options?.retryAfterMs,
    })
  }
  return new ApiResponseError(status, message, cause)
}

/** Recognise the several shapes an aborted or timed-out request arrives in. */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const name = 'name' in error ? String(error.name) : ''
  const code = 'code' in error ? String(error.code) : ''
  return name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR'
}
