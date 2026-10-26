"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlarmFeedClock = void 0;
const settings_1 = require("../settings");
/** The two freshness clocks behind {@link AlarmFeedConditions}. */
class AlarmFeedClock {
    #lastRefreshAt = null;
    #lastAnsweredAt = null;
    /** Record a finished REST read that counts as a refresh. */
    record(refresh, nowMs) {
        this.#lastRefreshAt = nowMs;
        if (refresh === 'answered') {
            this.#lastAnsweredAt = nowMs;
        }
    }
    /** Last finished refresh, answered or not. `null` before the first one. */
    get lastRefreshAt() {
        return this.#lastRefreshAt;
    }
    /** Last refresh Nest actually answered. `null` before the first one. */
    get lastAnsweredAt() {
        return this.#lastAnsweredAt;
    }
    /** Whether cached Protect smoke and CO may be shown as live. */
    isLive(nowMs, conditions) {
        if (conditions.isStopped
            || conditions.isForbiddenDead
            || conditions.hasLoopExited
            || !conditions.isBreakerClosed) {
            return false;
        }
        if (this.#lastRefreshAt === null || this.#lastAnsweredAt === null) {
            return false;
        }
        return nowMs - this.#lastRefreshAt <= settings_1.REST_ALARM_FEED_STALE_MS
            && nowMs - this.#lastAnsweredAt <= settings_1.REST_RESPONSE_STALE_MS;
    }
    /**
     * First instant at which age alone makes the feed stale.
     *
     * One past the last live millisecond, so a timer set for it sees the flip.
     * `null` before Nest has answered once.
     */
    ageExpiresAt() {
        if (this.#lastRefreshAt === null || this.#lastAnsweredAt === null) {
            return null;
        }
        return Math.min(this.#lastRefreshAt + settings_1.REST_ALARM_FEED_STALE_MS, this.#lastAnsweredAt + settings_1.REST_RESPONSE_STALE_MS) + 1;
    }
}
exports.AlarmFeedClock = AlarmFeedClock;
