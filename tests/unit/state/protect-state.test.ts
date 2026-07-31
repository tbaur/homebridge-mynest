/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Protect state, and the honesty rules around it.
 *
 * Two of these behaviours are deliberate limitations rather than features, and
 * they are tested so nobody "fixes" them later without reading why: alarm state
 * is never inferred from the Observe stream, and occupancy is only reported
 * where Nest actually computes it.
 */

import { decodeFrame } from '../../../src/api/protobuf'
import { ObserveState } from '../../../src/state/observe-state'
import {
  describeOccupancySource,
  readProtectState,
  resolveOccupancy,
  toAlarmLevel,
} from '../../../src/state/protect-state'
import type { TopazBucket } from '../../../src/types/nest'
import { buildFrame, protectTraits } from '../../helpers/observe-fixtures'

const RESOURCE_ID = 'DEVICE_TEST_PROTECT'

function observeWithProtect(): ObserveState {
  const state = new ObserveState()
  state.apply(decodeFrame(buildFrame(protectTraits(RESOURCE_ID))).traits)
  return state
}

const wiredTopaz: TopazBucket = {
  serial_number: 'TEST_PROTECT',
  line_power_present: true,
  smoke_status: 0,
  co_status: 0,
  battery_health_state: 0,
  battery_level: 5226,
  auto_away: false,
}

describe('toAlarmLevel', () => {
  it.each([
    [0, 'ok'],
    [1, 'warning'],
    [2, 'emergency'],
  ])('maps status %i to %s', (status, expected) => {
    expect(toAlarmLevel(status)).toBe(expected)
  })

  it('treats an unrecognised status as an emergency', () => {
    // On a smoke alarm, the safe reading of an unknown non-zero value is that
    // something is wrong.
    expect(toAlarmLevel(99)).toBe('emergency')
  })

  it('says nothing when Nest reported no status', () => {
    expect(toAlarmLevel(undefined)).toBeUndefined()
  })
})

describe('resolveOccupancy', () => {
  it('reports occupied when Nest has recently seen somebody', () => {
    // Nest's flag means "nobody detected", so it is inverted for HomeKit.
    expect(resolveOccupancy({ topaz: { auto_away: false }, isLinePowered: true }))
      .toEqual({ isOccupied: true, occupancySource: 'auto_away' })
  })

  it('reports unoccupied once Nest has set auto away', () => {
    expect(resolveOccupancy({ topaz: { auto_away: true }, isLinePowered: true }))
      .toEqual({ isOccupied: false, occupancySource: 'auto_away' })
  })

  it('declines to report occupancy for a battery-powered Protect', () => {
    expect(resolveOccupancy({ topaz: { auto_away: false }, isLinePowered: false }))
      .toEqual({ occupancySource: 'unsupported_battery_powered' })
  })

  it('declines to report occupancy for a Protect missing from REST', () => {
    // This account has exactly one such Protect. It must still work as a smoke
    // alarm, but occupancy is only published by REST.
    expect(resolveOccupancy({ topaz: undefined, isLinePowered: true }))
      .toEqual({ occupancySource: 'unavailable_observe_only' })
  })

  it('declines to report occupancy when REST omits the flag', () => {
    expect(resolveOccupancy({ topaz: { serial_number: 'X' }, isLinePowered: true }))
      .toEqual({ occupancySource: 'unavailable_no_auto_away' })
  })

  it('declines to report occupancy when mains power is unknown', () => {
    expect(resolveOccupancy({ topaz: { auto_away: false }, isLinePowered: undefined }))
      .toEqual({ occupancySource: 'unavailable_power_unknown' })
  })

  it('keeps last occupancy when the REST alarm feed is unavailable', () => {
    expect(resolveOccupancy({
      topaz: { auto_away: false },
      isLinePowered: true,
      restAlarmFeedAvailable: false,
    })).toEqual({
      isOccupied: true,
      occupancySource: 'unavailable_rest_stale',
    })
  })

  it('marks occupancy stale without a verdict when REST is down and topaz has no auto_away', () => {
    expect(resolveOccupancy({
      topaz: { serial_number: 'X' },
      isLinePowered: true,
      restAlarmFeedAvailable: false,
    })).toEqual({ occupancySource: 'unavailable_rest_stale' })
  })
})

describe('readProtectState', () => {
  it('takes alarm state from REST', () => {
    const state = readProtectState({
      state: observeWithProtect(),
      resourceId: RESOURCE_ID,
      topaz: { ...wiredTopaz, smoke_status: 2, co_status: 1 },
    })

    expect(state.smoke).toBe('emergency')
    expect(state.carbonMonoxide).toBe('warning')
  })

  it('leaves alarm state unknown when REST does not report the device', () => {
    // The Observe stream does carry safety traits, but no public schema exists
    // for them and every captured sample reads all-clear — so there is nothing
    // to validate a guessed mapping against. Reporting "no smoke" on that basis
    // is the one mistake here that could matter to somebody's safety.
    const state = readProtectState({
      state: observeWithProtect(),
      resourceId: RESOURCE_ID,
      topaz: undefined,
    })

    expect(state.smoke).toBeUndefined()
    expect(state.carbonMonoxide).toBeUndefined()
  })

  it('keeps cached REST alarms but marks the feed stale when REST is unavailable', () => {
    // Stale topaz must not leave HomeKit showing a *live* all-clear while
    // Observe still reports the Protect online — but services stay published.
    const state = readProtectState({
      state: observeWithProtect(),
      resourceId: RESOURCE_ID,
      topaz: wiredTopaz,
      restAlarmFeedAvailable: false,
    })

    expect(state.smoke).toBe('ok')
    expect(state.carbonMonoxide).toBe('ok')
    expect(state.isAlarmFeedStale).toBe(true)
    expect(state.isOccupied).toBe(true)
    expect(state.occupancySource).toBe('unavailable_rest_stale')
    expect(state.isOnline).toBe(true)
    expect(state.isBatteryLow).toBe(false)
  })

  it('takes online status from Observe, so REST-less Protects still report it', () => {
    const state = readProtectState({
      state: observeWithProtect(),
      resourceId: RESOURCE_ID,
      topaz: undefined,
    })

    expect(state.isOnline).toBe(true)
    expect(state.isLinePowered).toBe(true)
  })

  it('reports battery health from Observe when REST is absent', () => {
    const state = readProtectState({
      state: observeWithProtect(),
      resourceId: RESOURCE_ID,
      topaz: undefined,
    })

    expect(state.isBatteryLow).toBe(false)
  })

  it('prefers REST battery health when both transports report', () => {
    const state = readProtectState({
      state: observeWithProtect(),
      resourceId: RESOURCE_ID,
      topaz: { ...wiredTopaz, battery_health_state: 1 },
    })

    expect(state.isBatteryLow).toBe(true)
  })

  it('converts the REST battery reading from millivolts to volts', () => {
    // `battery_level` reads like a percentage and is not one: a healthy Protect
    // reports about 5226.
    const state = readProtectState({
      state: observeWithProtect(),
      resourceId: RESOURCE_ID,
      topaz: wiredTopaz,
    })

    expect(state.batteryVolts).toBeCloseTo(5.226)
  })

  it('says nothing about the battery when neither transport reports it', () => {
    const state = readProtectState({
      state: new ObserveState(),
      resourceId: RESOURCE_ID,
      topaz: undefined,
    })

    expect(state.isBatteryLow).toBeUndefined()
    expect(state.batteryVolts).toBeUndefined()
    expect(state.isOnline).toBeUndefined()
  })

  it('falls back to the REST temperature when Observe has none', () => {
    const state = readProtectState({
      state: new ObserveState(),
      resourceId: RESOURCE_ID,
      topaz: { ...wiredTopaz, current_temperature: 20.5 },
    })

    expect(state.temperatureC).toBe(20.5)
  })

  it('rejects an implausible REST temperature rather than pushing it to HomeKit', () => {
    const state = readProtectState({
      state: new ObserveState(),
      resourceId: RESOURCE_ID,
      topaz: { ...wiredTopaz, current_temperature: 999 },
    })

    expect(state.temperatureC).toBeUndefined()
  })

  it('reads wall_power present=false when the trait exists but proto3 omitted the field', () => {
    // proto3 drops `false`; once the trait is present, absence means unpowered.
    const observe = new ObserveState()
    observe.apply(decodeFrame(buildFrame([
      {
        resourceId: RESOURCE_ID,
        key: 'wall_power',
        typeName: 'weave.trait.power.PowerSourceTrait',
        value: {},
      },
    ])).traits)

    const state = readProtectState({
      state: observe,
      resourceId: RESOURCE_ID,
      topaz: undefined,
    })

    expect(state.isLinePowered).toBe(false)
  })
})

describe('describeOccupancySource', () => {
  it('explains that auto away is presence, not motion', () => {
    const explanation = describeOccupancySource('auto_away')

    expect(explanation).toContain('10 minutes')
    expect(explanation).toContain('not motion detection')
  })

  it('explains every reason occupancy can be missing', () => {
    expect(describeOccupancySource('unsupported_battery_powered')).toContain('battery-powered')
    expect(describeOccupancySource('unavailable_observe_only')).toContain('REST')
    expect(describeOccupancySource('unavailable_no_auto_away')).toContain('auto_away')
    expect(describeOccupancySource('unavailable_power_unknown')).toContain('mains-powered')
    expect(describeOccupancySource('unavailable_rest_stale')).toContain('not refreshing')
  })
})
