"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Structured error hierarchy for predictable error handling.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreakerError = exports.ObserveStreamError = exports.ApiParseError = exports.ApiResponseError = exports.RateLimitError = exports.TimeoutError = exports.NetworkError = exports.SessionShapeError = exports.ForbiddenError = exports.AuthenticationError = exports.ConfigurationError = exports.NestError = void 0;
exports.isCircuitBreakerFailure = isCircuitBreakerFailure;
exports.parseRetryAfterMs = parseRetryAfterMs;
exports.createApiError = createApiError;
exports.isAbortError = isAbortError;
const settings_1 = require("../settings");
/**
 * Base class for all plugin errors.
 *
 * Carries a stable machine-readable `code` and an `isRetryable` hint so callers
 * can make retry decisions without string-matching messages — which matters
 * here because Nest's error text is inconsistent and unversioned.
 */
class NestError extends Error {
    httpStatus;
    timestamp;
    constructor(message, options) {
        super(message, options);
        this.name = this.constructor.name;
        this.timestamp = new Date();
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}
exports.NestError = NestError;
/** Configuration is missing or invalid; not recoverable without user action. */
class ConfigurationError extends NestError {
    code = 'CONFIG_ERROR';
    isRetryable = false;
}
exports.ConfigurationError = ConfigurationError;
/**
 * Nest rejected the access token (HTTP 401).
 *
 * Not retryable: the token is copied by hand from a browser session and only a
 * new one will help. Retrying a rejected token is also how an account attracts
 * attention it does not want.
 */
class AuthenticationError extends NestError {
    code = 'AUTH_ERROR';
    isRetryable = false;
    httpStatus = 401;
    constructor(message = 'Nest rejected the configured access token. Sign in at https://home.nest.com, open https://home.nest.com/session, and copy a fresh "access_token".', options) {
        super(message, options);
    }
}
exports.AuthenticationError = AuthenticationError;
/**
 * Nest answered HTTP 403 Forbidden.
 *
 * Retryable with backoff: on the per-account transport host a 403 can be a WAF
 * or bot-detection blip against the pinned browser user agent, not a dead
 * token. The transport escalates to fatal only after several consecutive 403s.
 */
class ForbiddenError extends NestError {
    code = 'FORBIDDEN_ERROR';
    isRetryable = true;
    httpStatus = 403;
    constructor(message, options) {
        super(message, options);
    }
}
exports.ForbiddenError = ForbiddenError;
/**
 * The session JSON was accepted but did not carry what the plugin needs.
 *
 * Distinguished from an authentication failure because the remedy is a plugin
 * update, not a new token: it means Nest changed the shape of the response.
 */
class SessionShapeError extends NestError {
    code = 'SESSION_SHAPE_ERROR';
    isRetryable = false;
    constructor(missing, options) {
        super(`The Nest session response is missing ${missing.join(', ')}. Nest may have changed its session format; please report this.`, options);
    }
}
exports.SessionShapeError = SessionShapeError;
/** Network-level failure (DNS, connection reset, etc.). Safe to retry. */
class NetworkError extends NestError {
    code = 'NETWORK_ERROR';
    isRetryable = true;
}
exports.NetworkError = NetworkError;
/** Request exceeded the configured timeout. Safe to retry. */
class TimeoutError extends NestError {
    code = 'TIMEOUT_ERROR';
    isRetryable = true;
}
exports.TimeoutError = TimeoutError;
/** Rate limited by Nest (429). Retryable with backoff. */
class RateLimitError extends NestError {
    code = 'RATE_LIMIT_ERROR';
    isRetryable = true;
    httpStatus = 429;
    /** Server-suggested wait from `Retry-After`, when present. */
    retryAfterMs;
    constructor(message, options) {
        super(message, options?.cause ? { cause: options.cause } : undefined);
        this.retryAfterMs = options?.retryAfterMs;
    }
}
exports.RateLimitError = RateLimitError;
/** Non-2xx response that isn't auth or rate limiting. Retryable only for 5xx. */
class ApiResponseError extends NestError {
    code = 'API_RESPONSE_ERROR';
    isRetryable;
    httpStatus;
    constructor(status, message, options) {
        super(message, options);
        this.httpStatus = status;
        this.isRetryable = status >= 500;
    }
}
exports.ApiResponseError = ApiResponseError;
/**
 * Response body could not be parsed as expected.
 *
 * Usually an HTML error or interstitial served where JSON was expected, which
 * is what Nest returns when a request is refused at the edge. Retryable,
 * because a single bad payload should not permanently stop the poll loop.
 */
class ApiParseError extends NestError {
    code = 'API_PARSE_ERROR';
    isRetryable = true;
}
exports.ApiParseError = ApiParseError;
/**
 * The Observe stream failed or went silent.
 *
 * Retryable by design: this is the primary state source for thermostats, so
 * the run loop reconnects with backoff rather than giving up.
 */
class ObserveStreamError extends NestError {
    code = 'OBSERVE_STREAM_ERROR';
    isRetryable = true;
}
exports.ObserveStreamError = ObserveStreamError;
/**
 * A Nest transport circuit breaker is open.
 *
 * Not retryable inside a single logical request — the loop should wait out
 * {@link retryAfterMs} and try again on the next cycle.
 */
class CircuitBreakerError extends NestError {
    code = 'CIRCUIT_OPEN';
    isRetryable = false;
    resetTime;
    constructor(resetTimeMs, options) {
        const resetTime = new Date(Date.now() + resetTimeMs);
        super(`Circuit breaker is open. Nest unavailable until ${resetTime.toISOString()}`, options);
        this.resetTime = resetTime;
    }
    get retryAfterMs() {
        return Math.max(0, this.resetTime.getTime() - Date.now());
    }
}
exports.CircuitBreakerError = CircuitBreakerError;
/**
 * Whether a failure should count toward opening a Nest transport breaker.
 *
 * Auth, 403, and rate-limit paths have their own handling and must not trip
 * the breaker. Sustained 5xx / network / parse / Observe stream failures do.
 */
function isCircuitBreakerFailure(error) {
    if (error instanceof CircuitBreakerError) {
        return false;
    }
    if (error instanceof AuthenticationError
        || error instanceof ForbiddenError
        || error instanceof ConfigurationError
        || error instanceof RateLimitError
        || error instanceof SessionShapeError) {
        return false;
    }
    if (error instanceof NetworkError
        || error instanceof TimeoutError
        || error instanceof ApiParseError
        || error instanceof ObserveStreamError) {
        return true;
    }
    if (error instanceof ApiResponseError) {
        return error.httpStatus >= 500;
    }
    return false;
}
/**
 * Clamp an untrusted delay to something `setTimeout` can actually honour.
 *
 * Node collapses any delay above 2^31-1 ms to 1 ms, so an absurd server value
 * would turn "wait a very long time" into "retry immediately" — the exact
 * opposite of what a rate-limited endpoint is asking for.
 */
function clampRetryAfterMs(ms) {
    return Math.min(settings_1.MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
}
/**
 * Parse an HTTP `Retry-After` value into a millisecond delay.
 *
 * Accepts either a delay in seconds or an HTTP-date. Invalid values are ignored
 * so callers fall back to computed backoff; valid ones are clamped, because the
 * header is remote input and is fed straight to `setTimeout`.
 */
function parseRetryAfterMs(header) {
    if (!header) {
        return undefined;
    }
    const trimmed = header.trim();
    if (!trimmed) {
        return undefined;
    }
    // Anything numeric is settled here rather than falling through to the date
    // branch, where `Date.parse` reads "-5" as a year and turns a nonsensical
    // delay into "retry immediately".
    const asSeconds = Number(trimmed);
    if (Number.isFinite(asSeconds)) {
        return asSeconds >= 0 ? clampRetryAfterMs(asSeconds * 1_000) : undefined;
    }
    const asDate = Date.parse(trimmed);
    if (!Number.isNaN(asDate)) {
        return clampRetryAfterMs(asDate - Date.now());
    }
    return undefined;
}
/**
 * Map an HTTP status to the appropriate error type.
 *
 * Nest answers a bad or expired token with 401. A 403 on the transport host is
 * sometimes the same, but can also be a transient edge refusal, so it becomes
 * {@link ForbiddenError} and is only treated as fatal after repeated hits.
 */
function createApiError(status, message, options) {
    const cause = options?.cause ? { cause: options.cause } : undefined;
    if (status === 401) {
        return new AuthenticationError(message, cause);
    }
    if (status === 403) {
        return new ForbiddenError(message, cause);
    }
    if (status === 429) {
        return new RateLimitError(message, {
            cause: options?.cause,
            retryAfterMs: options?.retryAfterMs,
        });
    }
    return new ApiResponseError(status, message, cause);
}
/** Recognise the several shapes an aborted or timed-out request arrives in. */
function isAbortError(error) {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const name = 'name' in error ? String(error.name) : '';
    const code = 'code' in error ? String(error.code) : '';
    return name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR';
}
//# sourceMappingURL=index.js.map