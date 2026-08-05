"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreaker = exports.DEFAULT_CIRCUIT_BREAKER_CONFIG = exports.CircuitState = void 0;
const errors_1 = require("../errors");
/** Circuit breaker states. */
var CircuitState;
(function (CircuitState) {
    /** Normal operation; requests flow through. */
    CircuitState["CLOSED"] = "CLOSED";
    /** Tripped; requests fail immediately. */
    CircuitState["OPEN"] = "OPEN";
    /** Probing whether the service recovered. */
    CircuitState["HALF_OPEN"] = "HALF_OPEN";
})(CircuitState || (exports.CircuitState = CircuitState = {}));
/**
 * Defaults tuned for Nest's dual independent transports.
 *
 * `halfOpenMax: 1` avoids concurrent probe races when a loop retries quickly.
 */
exports.DEFAULT_CIRCUIT_BREAKER_CONFIG = {
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
    halfOpenMax: 1,
    failureWindowMs: 60_000,
};
/** Circuit breaker guarding calls to one Nest transport. */
class CircuitBreaker {
    #failureThreshold;
    #resetTimeoutMs;
    #halfOpenMax;
    #failureWindowMs;
    #onStateChange;
    #state = CircuitState.CLOSED;
    #successes = 0;
    #lastFailureTime = null;
    #halfOpenRequests = 0;
    #failureTimestamps = [];
    constructor(config = {}) {
        const merged = { ...exports.DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
        this.#failureThreshold = merged.failureThreshold;
        this.#resetTimeoutMs = merged.resetTimeoutMs;
        this.#halfOpenMax = merged.halfOpenMax;
        this.#failureWindowMs = merged.failureWindowMs;
        this.#onStateChange = merged.onStateChange;
    }
    /**
     * Chain an additional state-change listener without replacing any listener
     * already supplied at construction.
     */
    attachOnStateChange(handler) {
        const previous = this.#onStateChange;
        this.#onStateChange = (from, to) => {
            previous?.(from, to);
            handler(from, to);
        };
    }
    get state() {
        return this.#state;
    }
    get isOpen() {
        return this.#state === CircuitState.OPEN;
    }
    /** Transition state, notifying observers only on an actual change. */
    #transitionTo(next) {
        if (this.#state === next) {
            return;
        }
        const previous = this.#state;
        this.#state = next;
        this.#onStateChange?.(previous, next);
    }
    /** Drop failures that have aged out of the sliding window. */
    #pruneFailures() {
        const cutoff = Date.now() - this.#failureWindowMs;
        this.#failureTimestamps = this.#failureTimestamps.filter((ts) => ts > cutoff);
    }
    /** Whether a request may proceed right now. */
    canRequest() {
        if (this.#state === CircuitState.CLOSED) {
            return true;
        }
        if (this.#state === CircuitState.OPEN) {
            const isCooldownElapsed = this.#lastFailureTime !== null
                && Date.now() - this.#lastFailureTime >= this.#resetTimeoutMs;
            if (isCooldownElapsed) {
                this.#halfOpenRequests = 0;
                this.#successes = 0;
                this.#transitionTo(CircuitState.HALF_OPEN);
                return true;
            }
            return false;
        }
        return this.#halfOpenRequests < this.#halfOpenMax;
    }
    recordSuccess() {
        if (this.#state === CircuitState.HALF_OPEN) {
            this.#successes++;
            if (this.#successes >= this.#halfOpenMax) {
                this.reset();
            }
            return;
        }
        if (this.#state === CircuitState.OPEN) {
            // An in-flight request that completed after the trip proves reachability.
            this.reset();
            return;
        }
        this.#pruneFailures();
    }
    recordFailure() {
        // Already open: ignore late failures so overlapping probes cannot keep
        // pushing lastFailureTime forward and extend the cooldown.
        if (this.#state === CircuitState.OPEN) {
            return;
        }
        const now = Date.now();
        this.#lastFailureTime = now;
        this.#failureTimestamps.push(now);
        if (this.#state === CircuitState.HALF_OPEN) {
            this.#halfOpenRequests = 0;
            this.#successes = 0;
            this.#transitionTo(CircuitState.OPEN);
            return;
        }
        if (this.#state === CircuitState.CLOSED) {
            this.#pruneFailures();
            if (this.#failureTimestamps.length >= this.#failureThreshold) {
                this.#transitionTo(CircuitState.OPEN);
            }
        }
    }
    reset() {
        this.#successes = 0;
        this.#lastFailureTime = null;
        this.#halfOpenRequests = 0;
        this.#failureTimestamps = [];
        this.#transitionTo(CircuitState.CLOSED);
    }
    getStatus() {
        this.#pruneFailures();
        const remainingResetTimeMs = this.#state === CircuitState.OPEN && this.#lastFailureTime !== null
            ? Math.max(0, this.#resetTimeoutMs - (Date.now() - this.#lastFailureTime))
            : null;
        return {
            state: this.#state,
            failures: this.#failureTimestamps.length,
            successes: this.#successes,
            lastFailureTime: this.#lastFailureTime,
            isOpen: this.isOpen,
            remainingResetTimeMs,
        };
    }
    /**
     * Run an operation under the breaker.
     *
     * @throws {CircuitBreakerError} The circuit is open.
     */
    async execute(operation, options = {}) {
        const isFailure = options.isFailure ?? (() => true);
        if (!this.canRequest()) {
            throw new errors_1.CircuitBreakerError(this.getStatus().remainingResetTimeMs ?? this.#resetTimeoutMs);
        }
        if (this.#state === CircuitState.HALF_OPEN) {
            this.#halfOpenRequests++;
        }
        try {
            const result = await operation();
            this.recordSuccess();
            return result;
        }
        catch (error) {
            const wasHalfOpen = this.#state === CircuitState.HALF_OPEN;
            if (wasHalfOpen || isFailure(error)) {
                this.recordFailure();
            }
            throw error;
        }
    }
}
exports.CircuitBreaker = CircuitBreaker;
