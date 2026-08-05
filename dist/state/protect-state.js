"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.toAlarmLevel = toAlarmLevel;
exports.resolveOccupancy = resolveOccupancy;
exports.readProtectState = readProtectState;
exports.describeOccupancySource = describeOccupancySource;
const traits_1 = require("./traits");
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
function toAlarmLevel(status) {
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 0) {
        return undefined;
    }
    if (status === 0) {
        return 'ok';
    }
    if (status === 1) {
        return 'warning';
    }
    return 'emergency';
}
/** Whether the Observe stream says the device is reachable. */
function readOnline(state, resourceId) {
    const status = (0, traits_1.readEnum)(state.trait(resourceId, 'liveness'), 'status');
    if (status === undefined) {
        return undefined;
    }
    return status === 'LIVENESS_DEVICE_STATUS_ONLINE';
}
/**
 * Millivolts as reported by REST, converted to volts.
 *
 * A healthy Protect reads about 5226 here. The field is named `battery_level`,
 * which reads like a percentage and is not one.
 */
const MILLIVOLTS_PER_VOLT = 1000;
/**
 * Whether the battery needs replacing.
 *
 * REST states this directly. Observe carries the same verdict as a Weave
 * `replacementIndicator`, which is what lets a Protect missing from REST — this
 * account has one — still warn about a flat battery.
 */
function readBatteryLow(state, resourceId, topaz) {
    if (typeof topaz?.battery_health_state === 'number') {
        return topaz.battery_health_state !== 0;
    }
    const indicator = (0, traits_1.readEnum)(state.trait(resourceId, 'battery'), 'replacementIndicator');
    if (indicator === undefined) {
        return undefined;
    }
    return indicator !== 'BATTERY_REPLACEMENT_INDICATOR_NOT_AT_ALL';
}
/**
 * Whether the Protect is running on mains power.
 *
 * Matters beyond diagnostics: Nest only computes `auto_away` for wired units,
 * so this is what decides whether occupancy can be offered at all.
 */
function readLinePowered(state, resourceId, topaz) {
    if (typeof topaz?.line_power_present === 'boolean') {
        return topaz.line_power_present;
    }
    // `wall_power` is a Weave PowerSourceTrait; `present` is its field for
    // "this power source is physically connected". proto3 omits `false`, and an
    // empty payload still means the trait was reported — so once the trait key
    // exists, absent/undefined `present` means not connected.
    if (!state.hasTrait(resourceId, 'wall_power')) {
        return undefined;
    }
    return state.trait(resourceId, 'wall_power')?.present === true;
}
/**
 * Decide what, if anything, can honestly be said about occupancy.
 *
 * Every branch that cannot produce a reading records *why*, so the platform can
 * explain itself in the log instead of silently publishing nothing.
 */
function resolveOccupancy(options) {
    const { topaz, isLinePowered, restAlarmFeedAvailable = true } = options;
    if (!restAlarmFeedAvailable) {
        // Keep last auto_away when we have it so the occupancy service is not torn
        // down for a Nest outage; the accessory marks the tile faulted/inactive.
        if (topaz
            && isLinePowered === true
            && typeof topaz.auto_away === 'boolean') {
            return {
                isOccupied: !topaz.auto_away,
                occupancySource: 'unavailable_rest_stale',
            };
        }
        return { occupancySource: 'unavailable_rest_stale' };
    }
    if (!topaz) {
        return { occupancySource: 'unavailable_observe_only' };
    }
    if (isLinePowered === false) {
        return { occupancySource: 'unsupported_battery_powered' };
    }
    // Nest only computes auto_away for wired Protects. When power is unknown,
    // publishing occupancy would invent a mains-powered verdict.
    if (isLinePowered !== true) {
        return { occupancySource: 'unavailable_power_unknown' };
    }
    if (typeof topaz.auto_away !== 'boolean') {
        return { occupancySource: 'unavailable_no_auto_away' };
    }
    // Inverted: Nest's flag means "nobody has been detected", HomeKit's means
    // "somebody is here".
    return { isOccupied: !topaz.auto_away, occupancySource: 'auto_away' };
}
/** Build Protect state by merging what each transport reports. */
function readProtectState(options) {
    const { state, resourceId, topaz, restAlarmFeedAvailable = true } = options;
    const isLinePowered = readLinePowered(state, resourceId, topaz);
    const isAlarmFeedStale = !restAlarmFeedAvailable && topaz !== undefined;
    return {
        // Observe-only (no topaz): leave undefined so the accessory never creates
        // smoke/CO tiles. REST-known Protects keep last topaz levels when the feed
        // goes stale; `isAlarmFeedStale` tells the accessory to fault them.
        smoke: toAlarmLevel(topaz?.smoke_status),
        carbonMonoxide: toAlarmLevel(topaz?.co_status),
        isAlarmFeedStale: isAlarmFeedStale || undefined,
        isBatteryLow: readBatteryLow(state, resourceId, topaz),
        batteryVolts: toVolts((0, traits_1.readNumber)(topaz, 'battery_level')),
        isOnline: readOnline(state, resourceId),
        isLinePowered,
        ...resolveOccupancy({ topaz, isLinePowered, restAlarmFeedAvailable }),
        temperatureC: (0, traits_1.readTemperatureC)(state.trait(resourceId, 'temperature'))
            ?? readPlausibleRestTemperature(topaz?.current_temperature),
        humidity: (0, traits_1.readHumidity)(state.trait(resourceId, 'humidity')),
    };
}
function toVolts(millivolts) {
    return millivolts === undefined ? undefined : millivolts / MILLIVOLTS_PER_VOLT;
}
function readPlausibleRestTemperature(value) {
    return typeof value === 'number' && Number.isFinite(value) && (0, traits_1.isPlausibleTemperature)(value)
        ? value
        : undefined;
}
/** A user-facing explanation for why occupancy is or is not published. */
function describeOccupancySource(source) {
    switch (source) {
        case 'auto_away':
            return 'occupancy comes from Nest\'s own "auto away" verdict, which changes about 10 minutes after the room empties and is not motion detection';
        case 'unsupported_battery_powered':
            return 'Nest does not compute occupancy for battery-powered Protects, so no occupancy sensor is published';
        case 'unavailable_observe_only':
            return 'this Protect is not in the account\'s REST device list, which is the only place Nest publishes occupancy, so no occupancy sensor is published';
        case 'unavailable_no_auto_away':
            return 'Nest listed this Protect over REST but did not publish an auto_away verdict, so no occupancy sensor is published';
        case 'unavailable_power_unknown':
            return 'Nest did not report whether this Protect is mains-powered, so occupancy is not published';
        case 'unavailable_rest_stale':
            return 'Nest REST is not refreshing alarm state, so occupancy is a cached reading marked inactive until REST recovers';
    }
}
