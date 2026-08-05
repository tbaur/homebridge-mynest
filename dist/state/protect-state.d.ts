/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Building Nest Protect state from both transports.
 *
 * Two constraints shape this file, both established by probing a live account:
 *
 * 1. **Alarm state comes from REST, and only from REST.** Observe does stream
 *    `safety_alarm_smoke` and `safety_alarm_co`, but no public schema for them
 *    exists and every sample ever captured on this account reads all-clear, so
 *    there is nothing to validate a guessed field mapping against. Inferring
 *    "no smoke" from an unverified enum is the one mistake in this plugin that
 *    could matter to somebody's safety, so it is not made: a Protect that REST
 *    does not report gets no smoke or CO sensor in HomeKit at all, and the user
 *    is told why. See `docs/PROTOCOL.md`.
 *
 * 2. **A Protect does not report motion.** It has a PIR sensor, but neither API
 *    exposes its events: `ambient_motion` carries no state at rest, and a
 *    12-hour capture recorded no motion deltas on either transport. What Nest
 *    does publish is `auto_away`, its own verdict that nobody has been seen for
 *    about ten minutes. That is presence at ten-minute resolution, and it is
 *    reported as occupancy rather than dressed up as motion.
 */
import type { AlarmLevel, OccupancySource, ProtectState } from '../types/device';
import type { TopazBucket } from '../types/nest';
import type { ObserveState } from './observe-state';
/**
 * Map a Nest alarm status code onto {@link AlarmLevel}.
 *
 * Nest uses `0` for clear and rising integers for severity. An unknown
 * *numeric* code is treated as an emergency: on a smoke alarm, the safe reading
 * of an unrecognised severity is that something is wrong.
 *
 * A value that is not a number at all is a different case, and must not take
 * that branch. `null` is how JSON commonly spells "no reading", and returning
 * `emergency` for it fires a critical HomeKit smoke alarm — plus every
 * automation wired to it — on every Protect in the house, from a single Nest
 * serialisation change. Absent and malformed both publish nothing instead.
 */
export declare function toAlarmLevel(status: unknown): AlarmLevel | undefined;
/**
 * Decide what, if anything, can honestly be said about occupancy.
 *
 * Every branch that cannot produce a reading records *why*, so the platform can
 * explain itself in the log instead of silently publishing nothing.
 */
export declare function resolveOccupancy(options: {
    topaz: TopazBucket | undefined;
    isLinePowered: boolean | undefined;
    /**
     * When false, cached REST topaz must not supply occupancy — same honesty
     * rule as smoke/CO when the REST alarm feed is unavailable.
     */
    restAlarmFeedAvailable?: boolean;
}): {
    isOccupied?: boolean;
    occupancySource: OccupancySource;
};
/** Build Protect state by merging what each transport reports. */
export declare function readProtectState(options: {
    state: ObserveState;
    resourceId: string;
    topaz: TopazBucket | undefined;
    /**
     * When false, last-known REST alarms are kept but marked stale so HomeKit
     * does not show a live all-clear — and services are not torn down.
     * Defaults to true for tests that only exercise merge maths.
     */
    restAlarmFeedAvailable?: boolean;
}): ProtectState;
/** A user-facing explanation for why occupancy is or is not published. */
export declare function describeOccupancySource(source: OccupancySource): string;
//# sourceMappingURL=protect-state.d.ts.map