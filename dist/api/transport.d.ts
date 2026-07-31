/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Runs both Nest transports for the lifetime of the plugin.
 *
 * The two loops are deliberately independent. Observe carries thermostats and
 * is the only place several devices appear at all; REST carries Protect alarm
 * state and battery levels. Either can fail without the other, and a home
 * where one is broken should keep updating through the one that works rather
 * than going dark.
 */
import { type NestEndpoints } from '../settings';
import type { BucketMap } from '../types/nest';
import type { TraitUpdate } from './protobuf';
import { type Http2Connect } from './observe';
import type { FetchLike } from './http';
import { type ThermostatSetpointWrite } from './thermostat-write';
import { CircuitBreaker, type CircuitBreakerStatus } from './circuit-breaker';
import type { Logger } from '../utils/logger';
export interface NestTransportOptions {
    accessToken: string;
    endpoints: NestEndpoints;
    log: Logger;
    /** Called with every trait the Observe stream reports, snapshot or patch. */
    onTraits: (traits: readonly TraitUpdate[]) => void;
    /** Called with the full bucket map after any REST change. */
    onBuckets: (buckets: BucketMap) => void;
    /**
     * Called when a new Observe connection is about to open.
     *
     * The platform uses this to collect the reconnect device snapshot so
     * Observe-only devices that Nest no longer reports can leave HomeKit.
     */
    onObserveSessionStart?: () => void;
    /** Called when a failure is not recoverable and the plugin should give up. */
    onFatal: (error: Error) => void;
    /**
     * Called when a transport circuit breaker opens (CLOSED/HALF_OPEN → OPEN).
     * Used by diagnostics to count trips; does not alter loop behaviour.
     */
    onCircuitOpen?: (transport: 'rest' | 'observe') => void;
    /**
     * Called when Protect smoke/CO may no longer (or may again) be treated as
     * live from cached REST topaz. The platform forces a Protect refresh so
     * StatusActive / StatusFault update; services are not removed.
     */
    onRestAlarmFeedChange?: (available: boolean) => void;
    /**
     * Optional metrics hooks for the opt-in diagnostics collector.
     * All callbacks are fire-and-forget; failures must not reach the loops.
     */
    metrics?: TransportMetrics;
    /**
     * When false, skip the fixed 15-minute transport status line (diagnostics
     * owns operator visibility instead). Defaults to true.
     */
    statusHeartbeatEnabled?: boolean;
    /** Injected REST breaker (tests); defaults to a fresh instance. */
    restCircuitBreaker?: CircuitBreaker;
    /** Injected Observe breaker (tests); defaults to a fresh instance. */
    observeCircuitBreaker?: CircuitBreaker;
    fetchImpl?: FetchLike;
    connect?: Http2Connect;
}
/** Counter hooks used by the platform diagnostics collector. */
export interface TransportMetrics {
    apiRequest?: (latencyMs: number, ok: boolean, options?: boolean | {
        networked?: boolean;
        sampleLatency?: boolean;
    }) => void;
    sessionLogin?: () => void;
    restCycle?: (ok: boolean, durationMs: number) => void;
    observeReconnect?: () => void;
    retry?: () => void;
}
/** What each loop is currently doing, for diagnostics. */
export interface TransportStatus {
    readonly hasSession: boolean;
    readonly observeFrames: number;
    readonly restCycles: number;
    readonly knownObjects: number;
    readonly observeState: 'connected' | 'connecting' | 'stopped' | 'forbidden_dead';
    readonly restState: 'running' | 'stopped' | 'forbidden_dead';
    readonly lastObserveFrameAgeSec: number | null;
    /**
     * Seconds since the last successful REST cycle (subscribe idle counts).
     * `null` until the first success after start.
     */
    readonly lastRestSuccessAgeSec: number | null;
    /**
     * Whether Protect smoke/CO (and REST occupancy) may be treated as live from
     * cached topaz. False when REST is stopped, forbidden-dead, breaker-open,
     * or past {@link REST_ALARM_FEED_STALE_MS} without a success — accessories
     * stay published and are marked inactive/faulted instead.
     */
    readonly isRestAlarmFeedAvailable: boolean;
    readonly circuitBreaker: {
        readonly rest: CircuitBreakerStatus;
        readonly observe: CircuitBreakerStatus;
    };
}
/** Owns the Nest session and both read loops. */
export declare class NestTransport {
    #private;
    constructor(options: NestTransportOptions);
    get status(): TransportStatus;
    /**
     * Authenticate and take the first full read of the account.
     *
     * Resolves once REST has been enumerated, which is enough to publish
     * accessories; the Observe snapshot follows within a second or two and is
     * pushed as an update rather than being waited for. Blocking on it would
     * delay every REST-visible device behind the slower transport.
     *
     * @throws {AuthenticationError} When the token is rejected. Nothing can
     *   proceed without a session, so this is surfaced rather than retried.
     */
    start(): Promise<void>;
    /**
     * Push a thermostat mode/setpoint change through BatchUpdateState.
     *
     * Observe-only thermostats have no REST `/v5/put` path; this is the write
     * Nest's own web app uses. Callers should already have gated on
     * `allowThermostatControl`.
     */
    updateThermostatSettings(write: ThermostatSetpointWrite): Promise<void>;
    /** Stop both loops and release the session. */
    stop(): void;
}
//# sourceMappingURL=transport.d.ts.map