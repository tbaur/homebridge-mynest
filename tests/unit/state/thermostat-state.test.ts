/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Thermostat state from each transport, and the merge of the two.
 */

import { decodeFrame } from '../../../src/api/protobuf'
import { ObserveState } from '../../../src/state/observe-state'
import {
  mergeThermostatState,
  readComfortSource,
  readThermostatFromObserve,
  readThermostatFromRest,
} from '../../../src/state/thermostat-state'
import { buildFrame, heatingThermostatTraits, type TraitFixture } from '../../helpers/observe-fixtures'

const RESOURCE_ID = 'DEVICE_THERM01'

function observeWith(traits: TraitFixture[]): ObserveState {
  const state = new ObserveState()
  state.apply(decodeFrame(buildFrame(traits)).traits)
  return state
}

const baseTraits = () => heatingThermostatTraits(RESOURCE_ID)

describe('readThermostatFromObserve', () => {
  it('reads temperature, mode, activity, and setpoint', () => {
    const state = readThermostatFromObserve(observeWith(baseTraits()), RESOURCE_ID)

    expect(state.currentTemperatureC).toBeCloseTo(19.5)
    expect(state.mode).toBe('heat')
    expect(state.activity).toBe('heating')
    expect(state.targetTemperatureC).toBeCloseTo(21)
  })

  it('reads the unit the device displays', () => {
    expect(readThermostatFromObserve(observeWith(baseTraits()), RESOURCE_ID).displayUnit).toBe('C')

    const fahrenheit = observeWith([
      ...baseTraits().filter((trait) => trait.key !== 'display_settings'),
      {
        resourceId: RESOURCE_ID,
        key: 'display_settings',
        typeName: 'nest.trait.hvac.DisplaySettingsTrait',
        value: { units: 'DEGREES_F' },
      },
    ])

    expect(readThermostatFromObserve(fahrenheit, RESOURCE_ID).displayUnit).toBe('F')
  })

  it('reads an absent capability flag as "cannot", not "unknown"', () => {
    // A heat-only thermostat really does report just `{ canHeat: 1 }`, because
    // proto3 omits a false. Reading that as unknown makes HomeKit offer a
    // cooling control the equipment does not have.
    const state = readThermostatFromObserve(observeWith(baseTraits()), RESOURCE_ID)

    expect(state.canHeat).toBe(true)
    expect(state.canCool).toBe(false)
  })

  it('leaves capabilities unknown until the trait arrives', () => {
    const withoutCapabilities = observeWith(
      baseTraits().filter((trait) => trait.key !== 'hvac_equipment_capabilities'),
    )
    const state = readThermostatFromObserve(withoutCapabilities, RESOURCE_ID)

    expect(state.canHeat).toBeUndefined()
    expect(state.canCool).toBeUndefined()
  })

  it('reports a switched-off thermostat as off, not as its last mode', () => {
    // Nest clears the `active` flag and leaves `hvacMode` at HEAT, so reading
    // the mode alone shows every off thermostat as heating.
    const off = observeWith([
      ...baseTraits().filter((trait) => trait.key !== 'target_temperature_settings'),
      {
        resourceId: RESOURCE_ID,
        key: 'target_temperature_settings',
        typeName: 'nest.trait.hvac.TargetTemperatureSettingsTrait',
        value: { settings: { hvacMode: 'HEAT', targetTemperatureHeat: { value: 21 } } },
      },
    ])

    const state = readThermostatFromObserve(off, RESOURCE_ID)
    expect(state.mode).toBe('off')
    expect(state.lastHvacMode).toBe('heat')
  })

  it('retains COOL as lastHvacMode while the thermostat is off', () => {
    const off = observeWith([
      ...baseTraits().filter((trait) => trait.key !== 'target_temperature_settings'),
      {
        resourceId: RESOURCE_ID,
        key: 'target_temperature_settings',
        typeName: 'nest.trait.hvac.TargetTemperatureSettingsTrait',
        value: { settings: { hvacMode: 'COOL', targetTemperatureCool: { value: 24 } } },
      },
    ])

    const state = readThermostatFromObserve(off, RESOURCE_ID)
    expect(state.mode).toBe('off')
    expect(state.lastHvacMode).toBe('cool')
  })

  it('reports idle when no relay is calling', () => {
    const idle = observeWith([
      ...baseTraits().filter((trait) => trait.key !== 'hvac_control'),
      {
        resourceId: RESOURCE_ID,
        key: 'hvac_control',
        typeName: 'nest.trait.hvac.HvacControlTrait',
        value: { settings: {} },
      },
    ])

    expect(readThermostatFromObserve(idle, RESOURCE_ID).activity).toBe('idle')
  })

  it('reports both bounds in range mode', () => {
    const range = observeWith([
      ...baseTraits().filter((trait) => trait.key !== 'target_temperature_settings'),
      {
        resourceId: RESOURCE_ID,
        key: 'target_temperature_settings',
        typeName: 'nest.trait.hvac.TargetTemperatureSettingsTrait',
        value: {
          active: { value: 1 },
          settings: {
            hvacMode: 'RANGE',
            targetTemperatureHeat: { value: 18 },
            targetTemperatureCool: { value: 24 },
          },
        },
      },
    ])
    const state = readThermostatFromObserve(range, RESOURCE_ID)

    expect(state.mode).toBe('range')
    expect(state.targetTemperatureLowC).toBeCloseTo(18)
    expect(state.targetTemperatureHighC).toBeCloseTo(24)
  })

  it('prefers a remote sensor reading when one is in control', () => {
    // A thermostat paired with a Temperature Sensor regulates to that sensor,
    // and the Nest app shows its reading. Publishing the backplate instead
    // makes the two apps disagree by degrees.
    const state = readThermostatFromObserve(observeWith(baseTraits()), RESOURCE_ID, {
      comfortTemperatureC: 22.75,
    })

    expect(state.currentTemperatureC).toBe(22.75)
  })

  it('says nothing about a thermostat it has never seen', () => {
    const state = readThermostatFromObserve(new ObserveState(), 'DEVICE_UNKNOWN')

    expect(state.currentTemperatureC).toBeUndefined()
    expect(state.mode).toBeUndefined()
  })
})

describe('readComfortSource', () => {
  it('names the sensor a thermostat is regulating to', () => {
    const state = observeWith([{
      resourceId: RESOURCE_ID,
      key: 'remote_comfort_sensing_settings',
      typeName: 'nest.trait.hvac.RemoteComfortSensingSettingsTrait',
      value: {
        activeRcsSelection: {
          rcsSourceType: 'RCS_SOURCE_TYPE_SINGLE_SENSOR',
          activeRcsSensor: { resourceId: 'DEVICE_SENSOR01' },
        },
      },
    }])

    expect(readComfortSource(state, RESOURCE_ID).sensorResourceId).toBe('DEVICE_SENSOR01')
  })

  it('names no sensor when the thermostat uses its own backplate', () => {
    const state = observeWith([{
      resourceId: RESOURCE_ID,
      key: 'remote_comfort_sensing_settings',
      typeName: 'nest.trait.hvac.RemoteComfortSensingSettingsTrait',
      value: { activeRcsSelection: { rcsSourceType: 'RCS_SOURCE_TYPE_BACKPLATE' } },
    }])

    expect(readComfortSource(state, RESOURCE_ID).sensorResourceId).toBeUndefined()
  })

  it('names no sensor when the trait is absent', () => {
    expect(readComfortSource(new ObserveState(), RESOURCE_ID)).toEqual({})
  })
})

describe('readThermostatFromRest', () => {
  it('reads the legacy bucket shape', () => {
    const state = readThermostatFromRest({
      current_temperature: 20,
      target_temperature: 22,
      target_temperature_type: 'heat',
      hvac_heater_state: true,
      can_heat: true,
      can_cool: false,
    }, { current_humidity: 40 })

    expect(state).toMatchObject({
      currentTemperatureC: 20,
      currentHumidity: 40,
      mode: 'heat',
      activity: 'heating',
      targetTemperatureC: 22,
      canHeat: true,
      canCool: false,
    })
  })

  it('reports cooling and idle from the relay states', () => {
    expect(readThermostatFromRest({ hvac_ac_state: true }, undefined).activity).toBe('cooling')
    expect(readThermostatFromRest({}, undefined).activity).toBe('idle')
  })

  it('says nothing at all when there is no bucket', () => {
    const state = readThermostatFromRest(undefined, undefined)

    expect(state.activity).toBeUndefined()
    expect(state.mode).toBeUndefined()
  })

  it('ignores a mode it does not recognise', () => {
    expect(readThermostatFromRest({ target_temperature_type: 'eco' }, undefined).mode)
      .toBeUndefined()
  })
})

describe('mergeThermostatState', () => {
  it('prefers Observe, which is the live push channel', () => {
    const merged = mergeThermostatState(
      { currentTemperatureC: 21, mode: 'heat' },
      { currentTemperatureC: 19, mode: 'cool' },
    )

    expect(merged).toMatchObject({ currentTemperatureC: 21, mode: 'heat' })
  })

  it('fills gaps from REST rather than overriding with it', () => {
    // A home with a mix of old and new thermostats then works without a special
    // case for either.
    const merged = mergeThermostatState(
      { currentTemperatureC: 21 },
      { currentHumidity: 40, targetTemperatureC: 22 },
    )

    expect(merged).toMatchObject({
      currentTemperatureC: 21,
      currentHumidity: 40,
      targetTemperatureC: 22,
    })
  })

  it('works when only one transport reported', () => {
    expect(mergeThermostatState(undefined, { mode: 'cool' }).mode).toBe('cool')
    expect(mergeThermostatState({ mode: 'heat' }, undefined).mode).toBe('heat')
    expect(mergeThermostatState(undefined, undefined).mode).toBeUndefined()
  })

  it('does not let a false capability be replaced by an absent one', () => {
    expect(mergeThermostatState({ canCool: false }, { canCool: true }).canCool).toBe(false)
  })
})
