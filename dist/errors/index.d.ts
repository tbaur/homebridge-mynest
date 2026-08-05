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
export declare abstract class NestError extends Error {
    abstract readonly code: string;
    abstract readonly isRetryable: boolean;
    readonly httpStatus?: number;
    readonly timestamp: Date;
    constructor(message: string, options?: {
        cause?: Error;
    });
}
/** Configuration is missing or invalid; not recoverable without user action. */
export declare class ConfigurationError extends NestError {
    readonly code = "CONFIG_ERROR";
    readonly isRetryable = false;
}
/**
 * Nest rejected the access token (HTTP 401).
 *
 * Not retryable: the token is copied by hand from a browser session and only a
 * new one will help. Retrying a rejected token is also how an account attracts
 * attention it does not want.
 */
export declare class AuthenticationError extends NestError {
    readonly code = "AUTH_ERROR";
    readonly isRetryable = false;
    readonly httpStatus = 401;
    constructor(message?: string, options?: {
        cause?: Error;
    });
}
/**
 * Nest answered HTTP 403 Forbidden.
 *
 * Retryable with backoff: on the per-account transport host a 403 can be a WAF
 * or bot-detection blip against the pinned browser user agent, not a dead
 * token. The transport escalates to fatal only after several consecutive 403s.
 */
export declare class ForbiddenError extends NestError {
    readonly code = "FORBIDDEN_ERROR";
    readonly isRetryable = true;
    readonly httpStatus = 403;
    constructor(message: string, options?: {
        cause?: Error;
    });
}
/**
 * The session JSON was accepted but did not carry what the plugin needs.
 *
 * Distinguished from an authentication failure because the remedy is a plugin
 * update, not a new token: it means Nest changed the shape of the response.
 */
export declare class SessionShapeError extends NestError {
    readonly code = "SESSION_SHAPE_ERROR";
    readonly isRetryable = false;
    constructor(missing: readonly string[], options?: {
        cause?: Error;
    });
}
/** Network-level failure (DNS, connection reset, etc.). Safe to retry. */
export declare class NetworkError extends NestError {
    readonly code = "NETWORK_ERROR";
    readonly isRetryable = true;
}
/** Request exceeded the configured timeout. Safe to retry. */
export declare class TimeoutError extends NestError {
    readonly code = "TIMEOUT_ERROR";
    readonly isRetryable = true;
}
/** Rate limited by Nest (429). Retryable with backoff. */
export declare class RateLimitError extends NestError {
    readonly code = "RATE_LIMIT_ERROR";
    readonly isRetryable = true;
    readonly httpStatus = 429;
    /** Server-suggested wait from `Retry-After`, when present. */
    readonly retryAfterMs?: number;
    constructor(message: string, options?: {
        cause?: Error;
        retryAfterMs?: number;
    });
}
/** Non-2xx response that isn't auth or rate limiting. Retryable only for 5xx. */
export declare class ApiResponseError extends NestError {
    readonly code = "API_RESPONSE_ERROR";
    readonly isRetryable: boolean;
    readonly httpStatus: number;
    constructor(status: number, message: string, options?: {
        cause?: Error;
    });
}
/**
 * Response body could not be parsed as expected.
 *
 * Usually an HTML error or interstitial served where JSON was expected, which
 * is what Nest returns when a request is refused at the edge. Retryable,
 * because a single bad payload should not permanently stop the poll loop.
 */
export declare class ApiParseError extends NestError {
    readonly code = "API_PARSE_ERROR";
    readonly isRetryable = true;
}
/**
 * The Observe stream failed or went silent.
 *
 * Retryable by design: this is the primary state source for thermostats, so
 * the run loop reconnects with backoff rather than giving up.
 */
export declare class ObserveStreamError extends NestError {
    readonly code = "OBSERVE_STREAM_ERROR";
    readonly isRetryable = true;
}
/**
 * A Nest transport circuit breaker is open.
 *
 * Not retryable inside a single logical request — the loop should wait out
 * {@link retryAfterMs} and try again on the next cycle.
 */
export declare class CircuitBreakerError extends NestError {
    readonly code = "CIRCUIT_OPEN";
    readonly isRetryable = false;
    readonly resetTime: Date;
    constructor(resetTimeMs: number, options?: {
        cause?: Error;
    });
    get retryAfterMs(): number;
}
/**
 * Whether a failure should count toward opening a Nest transport breaker.
 *
 * Auth, 403, and rate-limit paths have their own handling and must not trip
 * the breaker. Sustained 5xx / network / parse / Observe stream failures do.
 */
export declare function isCircuitBreakerFailure(error: unknown): boolean;
/**
 * Parse an HTTP `Retry-After` value into a millisecond delay.
 *
 * Accepts either a delay in seconds or an HTTP-date. Invalid values are ignored
 * so callers fall back to computed backoff; valid ones are clamped, because the
 * header is remote input and is fed straight to `setTimeout`.
 */
export declare function parseRetryAfterMs(header: string | null | undefined): number | undefined;
/**
 * Map an HTTP status to the appropriate error type.
 *
 * Nest answers a bad or expired token with 401. A 403 on the transport host is
 * sometimes the same, but can also be a transient edge refusal, so it becomes
 * {@link ForbiddenError} and is only treated as fatal after repeated hits.
 */
export declare function createApiError(status: number, message: string, options?: {
    cause?: Error;
    retryAfterMs?: number;
}): NestError;
/** Recognise the several shapes an aborted or timed-out request arrives in. */
export declare function isAbortError(error: unknown): boolean;
//# sourceMappingURL=index.d.ts.map