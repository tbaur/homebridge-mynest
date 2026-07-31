/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview One connection to Nest's Observe stream.
 *
 * Observe is an HTTP/2 POST whose response never ends: Nest sends a full trait
 * snapshot and then streams patches for as long as the connection lives. This
 * module owns exactly one such connection and always resolves with why it
 * finished, so the reconnect policy can live somewhere testable rather than
 * being tangled up with socket handling.
 *
 * The failure that matters here is not a dropped connection — that is obvious
 * and easy to recover from. It is a connection that stays open and stops
 * delivering, which is indistinguishable from a quiet house and leaves HomeKit
 * showing yesterday's temperature forever. That is what the idle deadline is
 * for.
 */
import http2 from 'node:http2';
import { type NestEndpoints } from '../settings';
import type { NestSession } from '../types/nest';
import type { Logger } from '../utils/logger';
/** Why an Observe connection finished. */
export type ObserveEndReason = 
/** The scheduled recycle deadline was reached; the stream was healthy. */
'recycled'
/** Nothing arrived within the idle deadline; the stream had gone silent. */
 | 'idle'
/** Nest closed the response. */
 | 'ended'
/** The caller asked to stop. */
 | 'aborted';
export interface ObserveSessionResult {
    readonly reason: ObserveEndReason;
    readonly frameCount: number;
    readonly durationMs: number;
}
/** Node's `http2.connect`, or a substitute supplied by tests. */
export type Http2Connect = typeof http2.connect;
export interface ObserveSessionOptions {
    session: NestSession;
    endpoints: NestEndpoints;
    log: Logger;
    /** Called for each complete frame, in order. */
    onFrame: (frame: Buffer) => void;
    /** Shutdown signal. Aborting resolves the session rather than rejecting it. */
    signal?: AbortSignal;
    connect?: Http2Connect;
    /** Overridable for tests; production uses the module constants. */
    sessionMs?: number;
    idleTimeoutMs?: number;
    pingIntervalMs?: number;
}
/**
 * Open one Observe connection and pump frames until it ends.
 *
 * @returns Why the connection finished, for the caller's reconnect policy.
 * @throws {ObserveStreamError} On a transport or protocol failure.
 */
export declare function runObserveSession(options: ObserveSessionOptions): Promise<ObserveSessionResult>;
//# sourceMappingURL=observe.d.ts.map