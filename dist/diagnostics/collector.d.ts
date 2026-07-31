/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Opt-in diagnostics collector for health/activity metrics.
 *
 * One collector is owned per platform instance. It accumulates cumulative
 * counters and a bounded latency window, and turns them into:
 *   - `buildHeartbeat()` — per-interval counter deltas + absolute gauges
 *   - `snapshot()`       — session cumulative totals + redacted config echo
 *   - `rollup()`         — `{ health, reasons[] }` health classification
 *
 * It only ever reads in-memory state via the supplied `readers`; it never
 * performs any network I/O.
 */
import type { ResolvedConfig } from '../types/config';
import type { DeviceGauges, DiagnosticsSnapshot, TransportGauges } from './types';
/** Accessors the collector calls to read live in-memory state. */
export interface DiagnosticsReaders {
    transport: () => TransportGauges;
    devices: () => DeviceGauges;
    /** Platform has permanently stopped after Nest auth failure. */
    fatalActive: () => boolean;
    /** Wall-clock seconds since platform start (for Observe silence grace). */
    uptimeSec: () => number;
}
interface CollectorOptions {
    pluginVersion: string;
    config: ResolvedConfig;
    /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
    now?: () => number;
}
/** Health classification result. */
export interface HealthRollup {
    health: 'healthy' | 'degraded';
    reasons: string[];
}
/** Accumulates diagnostics counters and renders heartbeat/snapshot reports. */
export declare class DiagnosticsCollector {
    #private;
    constructor(options: CollectorOptions);
    /**
     * Record a single API request outcome and its wall-clock duration.
     *
     * Latency is only sampled when a network fetch was actually attempted
     * (`networked`), so pre-flight skips do not skew percentiles.
     */
    apiRequest(latencyMs: number, ok: boolean, networked?: boolean): void;
    /** Record the result of a REST subscribe / app_launch cycle. */
    restCycle(ok: boolean, durationMs: number): void;
    /** Record an Observe reconnect (a new HTTP/2 session is opening). */
    observeReconnect(): void;
    /** Record a successful Nest session open / refresh. */
    sessionLogin(): void;
    /** Record a Nest-originated HomeKit state push. */
    externalChange(): void;
    /** Record a retry attempt. */
    retry(): void;
    /** Record a circuit-breaker trip (transition into the open state). */
    breakerTrip(): void;
    /**
     * Nearest-rank percentile (0..100) over the bounded recent-latency window.
     * Returns 0 when no samples are available.
     */
    percentile(p: number): number;
    /**
     * Classify current health from live readers.
     *
     * Degraded when Nest auth is fatal, either transport has given up on 403s,
     * a circuit breaker is open or probing, Observe has gone silent past the
     * grace window, or the recent API error rate is high. Observe-only Protects
     * missing REST smoke are expected and are not a degradation reason.
     */
    rollup(readers: DiagnosticsReaders): HealthRollup;
    /**
     * Build a heartbeat report: counters are deltas since the previous heartbeat
     * (the marker is then advanced) and everything else is an absolute gauge.
     */
    buildHeartbeat(readers: DiagnosticsReaders): DiagnosticsSnapshot;
    /**
     * Build a session-cumulative snapshot (no marker advance), including the
     * redacted config echo. Used for boot/shutdown reports.
     */
    snapshot(msg: string, readers: DiagnosticsReaders): DiagnosticsSnapshot;
}
export {};
//# sourceMappingURL=collector.d.ts.map