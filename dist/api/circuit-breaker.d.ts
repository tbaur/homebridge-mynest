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
/** Circuit breaker states. */
export declare enum CircuitState {
    /** Normal operation; requests flow through. */
    CLOSED = "CLOSED",
    /** Tripped; requests fail immediately. */
    OPEN = "OPEN",
    /** Probing whether the service recovered. */
    HALF_OPEN = "HALF_OPEN"
}
/** Circuit breaker tuning. */
export interface CircuitBreakerConfig {
    /** Failures within the window before the circuit opens. */
    failureThreshold: number;
    /** How long to stay open before probing again, in ms. */
    resetTimeoutMs: number;
    /** Consecutive successes needed to close from half-open. */
    halfOpenMax: number;
    /** Sliding window over which failures are counted, in ms. */
    failureWindowMs: number;
    /** Called on every state transition, for observability. */
    onStateChange?: (from: CircuitState, to: CircuitState) => void;
}
/**
 * Defaults tuned for Nest's dual independent transports.
 *
 * `halfOpenMax: 1` avoids concurrent probe races when a loop retries quickly.
 */
export declare const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig;
/** Snapshot of breaker state, for diagnostics. */
export interface CircuitBreakerStatus {
    state: CircuitState;
    failures: number;
    successes: number;
    lastFailureTime: number | null;
    isOpen: boolean;
    remainingResetTimeMs: number | null;
}
/** Options for {@link CircuitBreaker.execute}. */
export interface CircuitBreakerExecuteOptions {
    /**
     * Which errors count toward opening the breaker.
     *
     * Defaults to treating every thrown error as a failure. Nest callers pass a
     * filter so auth/403/rate-limit paths do not trip the breaker.
     */
    isFailure?: (error: unknown) => boolean;
}
/** Circuit breaker guarding calls to one Nest transport. */
export declare class CircuitBreaker {
    #private;
    constructor(config?: Partial<CircuitBreakerConfig>);
    /**
     * Chain an additional state-change listener without replacing any listener
     * already supplied at construction.
     */
    attachOnStateChange(handler: (from: CircuitState, to: CircuitState) => void): void;
    get state(): CircuitState;
    get isOpen(): boolean;
    /** Whether a request may proceed right now. */
    canRequest(): boolean;
    recordSuccess(): void;
    recordFailure(): void;
    reset(): void;
    getStatus(): CircuitBreakerStatus;
    /**
     * Run an operation under the breaker.
     *
     * @throws {CircuitBreakerError} The circuit is open.
     */
    execute<T>(operation: () => Promise<T>, options?: CircuitBreakerExecuteOptions): Promise<T>;
}
