"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Backoff and retry helpers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sleep = sleep;
exports.computeBackoffMs = computeBackoffMs;
exports.withRetry = withRetry;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
/** Awaitable delay. Exported so tests can substitute it and skip real waits. */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
function computeBackoffMs(attempt, baseMs = settings_1.RECONNECT_BASE_MS, maxMs = settings_1.RECONNECT_MAX_MS, random = Math.random) {
    const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
    // Full jitter over [base, exponential] rather than [0, exponential]: waiting
    // near-zero after a failure is just an immediate retry with extra steps.
    const floor = Math.min(baseMs, exponential);
    return Math.round(floor + random() * (exponential - floor));
}
const defaultIsRetryable = (error) => error instanceof errors_1.NestError && error.isRetryable;
/**
 * Run an operation, retrying retryable failures with backoff.
 *
 * A server-supplied `Retry-After` always wins over computed backoff: Nest
 * telling the client how long to wait is better information than a guess.
 */
async function withRetry(operation, options = {}) {
    const maxAttempts = options.maxAttempts ?? settings_1.MAX_REQUEST_ATTEMPTS;
    const isRetryable = options.isRetryable ?? defaultIsRetryable;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await operation();
        }
        catch (error) {
            lastError = error;
            if (!isRetryable(error) || attempt === maxAttempts) {
                throw error;
            }
            const serverDelay = error instanceof errors_1.RateLimitError ? error.retryAfterMs : undefined;
            const delayMs = serverDelay
                ?? computeBackoffMs(attempt, options.baseDelayMs, options.maxDelayMs);
            options.onRetry?.(attempt, delayMs, error);
            await sleep(delayMs);
        }
    }
    throw lastError;
}
//# sourceMappingURL=retry.js.map