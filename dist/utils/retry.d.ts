/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Backoff and retry helpers.
 */
/** Awaitable delay. Exported so tests can substitute it and skip real waits. */
export declare function sleep(ms: number): Promise<void>;
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
}
/**
 * Run an operation, retrying retryable failures with backoff.
 *
 * A server-supplied `Retry-After` always wins over computed backoff: Nest
 * telling the client how long to wait is better information than a guess.
 */
export declare function withRetry<T>(operation: () => Promise<T>, options?: RetryOptions): Promise<T>;
//# sourceMappingURL=retry.d.ts.map