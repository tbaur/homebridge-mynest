"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PENDING_ECO_MAX_MS = void 0;
exports.initialGlobalEcoState = initialGlobalEcoState;
exports.reduceGlobalEco = reduceGlobalEco;
/** How long a sent command may hold the switch against a non-matching aggregate. */
exports.PENDING_ECO_MAX_MS = 45_000;
/** Start from the cached switch position. A cached position is not a Nest reading. */
function initialGlobalEcoState(cachedOn) {
    return { shown: cachedOn, nestAllEco: undefined, nestReportedAtMs: undefined, pending: null };
}
function reduceGlobalEco(state, event) {
    switch (event.type) {
        case 'write_sent':
            return applyWriteSent(state, event.ecoOn, event.startedAtMs, event.nowMs);
        case 'expire':
            return expire(state);
        case 'nest_report':
            return applyNestReport(state, event.allEco, event.nowMs);
    }
}
function applyWriteSent(state, ecoOn, startedAtMs, nowMs) {
    // Nest can confirm the last thermostat before the slowest HTTP response
    // returns. Holding a pending command then would wait for a report that
    // already came and warn that Nest never confirmed.
    const isAlreadyConfirmed = state.nestAllEco === ecoOn
        && state.nestReportedAtMs !== undefined
        && state.nestReportedAtMs >= startedAtMs;
    if (isAlreadyConfirmed) {
        return { state: { ...state, shown: ecoOn, pending: null }, outcome: 'confirmed' };
    }
    return {
        state: { ...state, shown: ecoOn, pending: { ecoOn, sentAtMs: nowMs } },
        outcome: 'shown',
    };
}
function applyNestReport(state, allEco, nowMs) {
    const reported = { ...state, nestAllEco: allEco, nestReportedAtMs: nowMs };
    const { pending } = state;
    if (pending === null) {
        return { state: { ...reported, shown: allEco }, outcome: 'shown' };
    }
    if (pending.ecoOn === allEco) {
        return { state: { ...reported, shown: allEco, pending: null }, outcome: 'confirmed' };
    }
    if (nowMs - pending.sentAtMs >= exports.PENDING_ECO_MAX_MS) {
        return expire(reported);
    }
    return { state: reported, outcome: 'held' };
}
function expire(state) {
    if (state.pending === null) {
        return { state, outcome: 'unchanged' };
    }
    if (state.nestAllEco === undefined) {
        return { state: { ...state, pending: null }, outcome: 'expired_without_report' };
    }
    return {
        state: { ...state, shown: state.nestAllEco, pending: null },
        outcome: 'expired_to_nest',
    };
}
