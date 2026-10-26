/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Whether cached REST Protect alarm state is still live.
 *
 * Smoke and CO come only from REST `topaz` objects. HomeKit keeps the last
 * value, so the plugin has to say when that value stops being evidence. This
 * module is the only place that decides it. The transport records how each
 * REST read ended and passes in the loop conditions. Nothing else moves the
 * clocks.
 *
 * Two clocks, because a quiet house and a blackholed route look the same to
 * the subscribe long-poll: both end at the client deadline with no answer.
 *
 *   - `lastRefreshAt` moves on every finished subscribe cycle, answered or
 *     not, and on a complete `app_launch`. It catches a loop that stopped
 *     cycling.
 *   - `lastAnsweredAt` moves only when Nest answered with something that
 *     covers every known object. It catches a route that swallows traffic.
 *
 * An `app_launch` that the object list marks truncated moves neither clock.
 * It omitted Protects, so it is not evidence about them.
 */
/** Loop conditions that make the feed stale regardless of age. */
export interface AlarmFeedConditions {
    readonly isStopped: boolean;
    /** REST gave up after repeated HTTP 403s and is waiting to re-probe. */
    readonly isForbiddenDead: boolean;
    /** The subscribe loop ran and has since exited. */
    readonly hasLoopExited: boolean;
    readonly isBreakerClosed: boolean;
}
/** How one REST read ended, as far as Protect alarm freshness is concerned. */
export type RestRefresh = 
/** Nest answered, and the answer covers every known object. */
'answered'
/** The subscribe long-poll hit the client deadline with no answer. */
 | 'unanswered';
/** The two freshness clocks behind {@link AlarmFeedConditions}. */
export declare class AlarmFeedClock {
    #private;
    /** Record a finished REST read that counts as a refresh. */
    record(refresh: RestRefresh, nowMs: number): void;
    /** Last finished refresh, answered or not. `null` before the first one. */
    get lastRefreshAt(): number | null;
    /** Last refresh Nest actually answered. `null` before the first one. */
    get lastAnsweredAt(): number | null;
    /** Whether cached Protect smoke and CO may be shown as live. */
    isLive(nowMs: number, conditions: AlarmFeedConditions): boolean;
    /**
     * First instant at which age alone makes the feed stale.
     *
     * One past the last live millisecond, so a timer set for it sees the flip.
     * `null` before Nest has answered once.
     */
    ageExpiresAt(): number | null;
}
