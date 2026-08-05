/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest Temperature Sensor state, merged from both transports.
 *
 * The battery is the part worth pinning down. `battery_level` means percent on
 * a kryptonite bucket and millivolts on a topaz one, so a reading that is not a
 * plausible percentage has to be refused rather than handed to HomeKit.
 */

import { decodeFrame } from '../../../src/api/protobuf'
import { ObserveState } from '../../../src/state/observe-state'
import {
  LOW_BATTERY_PERCENT,
  LOW_BATTERY_VOLTS,
  readTemperatureSensorState,
} from '../../../src/state/sensor-state'
import type { KryptoniteBucket } from '../../../src/types/nest'
import { buildFrame, temperatureSensorTraits } from '../../helpers/observe-fixtures'

const RESOURCE_ID = 'DEVICE_SENSOR001'

function observeWithSensor(): ObserveState {
  const state = new ObserveState()
  state.apply(decodeFrame(buildFrame(temperatureSensorTraits(RESOURCE_ID))).traits)
  return state
}

function read(kryptonite: KryptoniteBucket | undefined, state = observeWithSensor()) {
  return readTemperatureSensorState({ state, resourceId: RESOURCE_ID, kryptonite })
}

describe('readTemperatureSensorState', () => {
  it('prefers the Observe reading over the REST one', () => {
    expect(read({ current_temperature: 30 }).temperatureC).toBe(18.25)
  })

  it('falls back to the REST reading when Observe has none', () => {
    expect(read({ current_temperature: 19.5 }, new ObserveState()).temperatureC).toBe(19.5)
  })

  it('refuses a REST reading outside what a building can produce', () => {
    expect(read({ current_temperature: 1000 }, new ObserveState()).temperatureC).toBeUndefined()
  })

  it('reports the REST battery percentage', () => {
    expect(read({ battery_level: 55 }).batteryLevel).toBe(55)
    expect(read({ battery_level: 55 }).isBatteryLow).toBe(false)
  })

  it('warns at or below the low-battery percentage', () => {
    expect(read({ battery_level: LOW_BATTERY_PERCENT }).isBatteryLow).toBe(true)
  })

  it('refuses a battery level that is not a plausible percentage', () => {
    // A topaz-shaped millivolt reading landing here would otherwise be handed
    // to HomeKit, which clamps it to 100 and warns on every push.
    const state = read({ battery_level: 5226 })

    expect(state.batteryLevel).toBeUndefined()
    // With no usable percentage it falls back to the Observe cell voltage.
    expect(state.isBatteryLow).toBe(false)
  })

  it('falls back to cell voltage when REST reports no percentage', () => {
    expect(read(undefined).isBatteryLow).toBe(false)

    const flat = new ObserveState()
    flat.apply(decodeFrame(buildFrame([
      {
        resourceId: RESOURCE_ID,
        key: 'battery',
        typeName: 'weave.trait.power.BatteryPowerSourceTrait',
        value: { assessedVoltage: { value: LOW_BATTERY_VOLTS } },
      },
    ])).traits)

    expect(read(undefined, flat).isBatteryLow).toBe(true)
  })

  it('says nothing about the battery when neither transport reported one', () => {
    expect(read(undefined, new ObserveState()).isBatteryLow).toBeUndefined()
  })
})
