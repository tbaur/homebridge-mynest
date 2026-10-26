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
 *    could matter to somebody's safety, so it is not made. A Protect with no
 *    decoded alarm number still publishes both sensors, marked inactive, and
 *    does not write a clear. See `docs/PROTOCOL.md`.
 *
 * 2. **A Protect does not report motion.** It has a PIR sensor, but neither API
 *    exposes its events: `ambient_motion` carries no state at rest, and a
 *    12-hour capture recorded no motion deltas on either transport. What Nest
 *    does publish is `auto_away`, its own verdict that nobody has been seen for
 *    about ten minutes. That is presence at ten-minute resolution, and it is
 *    reported as occupancy rather than dressed up as motion.
 */

import type { AlarmLevel, OccupancySource, ProtectState } from '../types/device'
import type { TopazBucket } from '../types/nest'
import type { ObserveState } from './observe-state'
import {
  isPlausibleTemperature,
  readEnum,
  readHumidity,
  readNumber,
  readTemperatureC,
} from './traits'

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
export function toAlarmLevel(status: unknown): AlarmLevel | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 0) {
    return undefined
  }
  if (status === 0) {
    return 'ok'
  }
  if (status === 1) {
    return 'warning'
  }
  return 'emergency'
}

/** Whether the Observe stream says the device is reachable. */
function readOnline(state: ObserveState, resourceId: string): boolean | undefined {
  const status = readEnum(state.trait(resourceId, 'liveness'), 'status')
  if (status === undefined) {
    return undefined
  }
  return status === 'LIVENESS_DEVICE_STATUS_ONLINE'
}

/**
 * Millivolts as reported by REST, converted to volts.
 *
 * A healthy Protect reads about 5226 here. The field is named `battery_level`,
 * which reads like a percentage and is not one.
 */
const MILLIVOLTS_PER_VOLT = 1000

/**
 * Whether the battery needs replacing.
 *
 * REST states this directly. Observe carries the same verdict as a Weave
 * `replacementIndicator`, which is what lets a Protect missing from REST — this
 * account has one — still warn about a flat battery.
 */
function readBatteryLow(
  state: ObserveState,
  resourceId: string,
  topaz: TopazBucket | undefined,
): boolean | undefined {
  if (typeof topaz?.battery_health_state === 'number') {
    return topaz.battery_health_state !== 0
  }

  const indicator = readEnum(state.trait(resourceId, 'battery'), 'replacementIndicator')
  if (indicator === undefined) {
    return undefined
  }
  return indicator !== 'BATTERY_REPLACEMENT_INDICATOR_NOT_AT_ALL'
}

/**
 * Whether the Protect is running on mains power.
 *
 * `false` omits occupancy. Unknown power does not: a boolean `auto_away` is
 * already Nest's verdict.
 */
function readLinePowered(
  state: ObserveState,
  resourceId: string,
  topaz: TopazBucket | undefined,
): boolean | undefined {
  if (typeof topaz?.line_power_present === 'boolean') {
    return topaz.line_power_present
  }

  // `wall_power` is a Weave PowerSourceTrait; `present` is its field for
  // "this power source is physically connected". proto3 omits `false`, and an
  // empty payload still means the trait was reported — so once the trait key
  // exists, absent/undefined `present` means not connected.
  if (!state.hasTrait(resourceId, 'wall_power')) {
    return undefined
  }
  return state.trait(resourceId, 'wall_power')?.present === true
}

/**
 * Decide what, if anything, can honestly be said about occupancy.
 *
 * Every branch that cannot produce a reading records *why*, so the platform can
 * explain itself in the log instead of silently publishing nothing.
 */
export function resolveOccupancy(options: {
  topaz: TopazBucket | undefined
  isLinePowered: boolean | undefined
  /**
   * When false, cached REST topaz must not supply occupancy — same honesty
   * rule as smoke/CO when the REST alarm feed is unavailable.
   */
  restAlarmFeedAvailable?: boolean
}): { isOccupied?: boolean, occupancySource: OccupancySource } {
  const { topaz, isLinePowered, restAlarmFeedAvailable = true } = options

  if (!restAlarmFeedAvailable) {
    // Keep last auto_away when we have it so the occupancy service is not torn
    // down for a Nest outage; the accessory marks the tile faulted/inactive.
    // Unknown power is not a veto: the boolean is already Nest's verdict.
    if (
      topaz
      && isLinePowered !== false
      && typeof topaz.auto_away === 'boolean'
    ) {
      return {
        isOccupied: !topaz.auto_away,
        occupancySource: 'unavailable_rest_stale',
      }
    }
  }

  if (!topaz) {
    return { occupancySource: 'unavailable_observe_only' }
  }

  if (isLinePowered === false) {
    return { occupancySource: 'unsupported_battery_powered' }
  }

  if (typeof topaz.auto_away !== 'boolean') {
    // Unknown power is not a veto once Nest has sent the boolean. A missing
    // boolean is the reason the sensor is omitted, whether or not power is known.
    return { occupancySource: 'unavailable_no_auto_away' }
  }

  // Inverted: Nest's flag means "nobody has been detected", HomeKit's means
  // "somebody is here".
  return { isOccupied: !topaz.auto_away, occupancySource: 'auto_away' }
}

/** Build Protect state by merging what each transport reports. */
export function readProtectState(options: {
  state: ObserveState
  resourceId: string
  topaz: TopazBucket | undefined
  /**
   * When false, last-known REST alarms are kept but marked stale so HomeKit
   * does not show a live all-clear — and services are not torn down.
   * Defaults to true for tests that only exercise merge maths.
   */
  restAlarmFeedAvailable?: boolean
}): ProtectState {
  const { state, resourceId, topaz, restAlarmFeedAvailable = true } = options
  const isLinePowered = readLinePowered(state, resourceId, topaz)
  const isAlarmFeedStale = !restAlarmFeedAvailable && topaz !== undefined

  return {
    // Missing numbers stay undefined. The accessory still publishes the sensor
    // and faults it, and does not write a clear. REST-known Protects keep last
    // topaz levels when the feed goes stale; `isAlarmFeedStale` faults them.
    smoke: toAlarmLevel(topaz?.smoke_status),
    carbonMonoxide: toAlarmLevel(topaz?.co_status),
    isAlarmFeedStale: isAlarmFeedStale || undefined,
    isBatteryLow: readBatteryLow(state, resourceId, topaz),
    batteryVolts: toVolts(readNumber(topaz, 'battery_level')),
    isOnline: readOnline(state, resourceId),
    isLinePowered,
    ...resolveOccupancy({ topaz, isLinePowered, restAlarmFeedAvailable }),
    temperatureC: readTemperatureC(state.trait(resourceId, 'temperature'))
      ?? readPlausibleRestTemperature(topaz?.current_temperature),
    humidity: readHumidity(state.trait(resourceId, 'humidity')),
  }
}

function toVolts(millivolts: number | undefined): number | undefined {
  return millivolts === undefined ? undefined : millivolts / MILLIVOLTS_PER_VOLT
}

function readPlausibleRestTemperature(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && isPlausibleTemperature(value)
    ? value
    : undefined
}

/**
 * One debug line with the raw REST fields behind a Protect's summary.
 *
 * `auto_away` false is Occupied. The accessory's info summary already shows
 * the readable state on change; this is for checking what Nest actually sent.
 */
export function formatTopazArrival(topaz: TopazBucket, label: string): string {
  const autoAway = typeof topaz.auto_away === 'boolean' ? String(topaz.auto_away) : 'absent'
  const smoke = typeof topaz.smoke_status === 'number' ? String(topaz.smoke_status) : 'absent'
  const co = typeof topaz.co_status === 'number' ? String(topaz.co_status) : 'absent'
  return `${label}: REST topaz auto_away=${autoAway} smoke_status=${smoke} co_status=${co}`
}

/** A user-facing explanation for why occupancy is or is not published. */
export function describeOccupancySource(source: OccupancySource): string {
  switch (source) {
    case 'auto_away':
      return 'uses Nest auto-away, not motion'
    case 'unsupported_battery_powered':
      return 'battery powered'
    case 'unavailable_observe_only':
      return 'not in the Nest REST device list'
    case 'unavailable_no_auto_away':
      return 'Nest sent no auto-away value'
    case 'unavailable_rest_stale':
      return 'alarm feed stale, occupancy marked inactive'
  }
}
