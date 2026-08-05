/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Backoff and retry helpers.
 */
/**
 * Awaitable delay that a shutdown can cut short.
 *
 * `unref`'d and abort-aware because the reconnect backoff reaches five minutes:
 * a plain timer would hold the Node event loop open for that long after
 * Homebridge has already asked everything to stop, delaying a service restart
 * and pushing containers into their SIGKILL grace period.
 *
 * Exported so tests can substitute it and skip real waits.
 */
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
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
export declare function computeBackoffMs(attempt: number, baseMs?: number, maxMs?: number, random?: () => number): number;
export interface RetryOptions {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    /** Decides whether a given failure is worth another attempt. */
    isRetryable?: (error: unknown) => boolean;
    onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
    /** Shutdown signal. Stops retrying rather than burning the attempt budget. */
    signal?: AbortSignal;
}
/**
 * Run an operation, retrying retryable failures with backoff.
 *
 * A server-supplied `Retry-After` always wins over computed backoff: Nest
 * telling the client how long to wait is better information than a guess.
 */
export declare function withRetry<T>(operation: () => Promise<T>, options?: RetryOptions): Promise<T>;
