/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview What the house-wide Eco switch shows, as a pure reducer.
 *
 * Nest confirms a house-wide Eco change one thermostat at a time, so the
 * all-Eco aggregate passes through partial values before it matches. The
 * switch therefore holds a sent command until Nest agrees, or until
 * {@link PENDING_ECO_MAX_MS} passes and Nest's latest aggregate wins.
 *
 * A write that was not sent or that failed is deliberately not an event. It
 * leaves the state alone: an earlier command that is still waiting keeps
 * waiting, and with nothing pending the switch keeps what it showed.
 */
/** How long a sent command may hold the switch against a non-matching aggregate. */
export declare const PENDING_ECO_MAX_MS = 45000;
export interface PendingEcoCommand {
    readonly ecoOn: boolean;
    readonly sentAtMs: number;
}
export interface GlobalEcoState {
    /** What the switch shows. */
    readonly shown: boolean;
    /** Latest aggregate Nest reported. `undefined` until Nest has reported one. */
    readonly nestAllEco: boolean | undefined;
    /** When {@link nestAllEco} arrived. */
    readonly nestReportedAtMs: number | undefined;
    /** Sent command that Nest has not confirmed yet. */
    readonly pending: PendingEcoCommand | null;
}
export type GlobalEcoEvent = {
    readonly type: 'nest_report';
    readonly allEco: boolean;
    readonly nowMs: number;
} | {
    readonly type: 'write_sent';
    readonly ecoOn: boolean;
    /** When the write was started, so a report during the write can confirm it. */
    readonly startedAtMs: number;
    readonly nowMs: number;
} | {
    readonly type: 'expire';
};
/**
 * What changed, for the accessory's log line.
 *
 * - `shown`: the switch follows the event.
 * - `confirmed`: Nest matched the command, before or after the write returned.
 * - `held`: a non-matching aggregate was stored, the command still shows.
 * - `expired_to_nest`: the command expired and the latest aggregate shows.
 * - `expired_without_report`: the command expired before Nest reported anything.
 * - `unchanged`: nothing to do.
 */
export type GlobalEcoOutcome = 'shown' | 'confirmed' | 'held' | 'expired_to_nest' | 'expired_without_report' | 'unchanged';
export interface GlobalEcoTransition {
    readonly state: GlobalEcoState;
    readonly outcome: GlobalEcoOutcome;
}
/** Start from the cached switch position. A cached position is not a Nest reading. */
export declare function initialGlobalEcoState(cachedOn: boolean): GlobalEcoState;
export declare function reduceGlobalEco(state: GlobalEcoState, event: GlobalEcoEvent): GlobalEcoTransition;
