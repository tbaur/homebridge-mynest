/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The union of both transports.
 *
 * The account this plugin was built against has a Protect that REST does not
 * list and five thermostats REST does not list either, while REST lists devices
 * of its own. Trusting either transport alone loses devices, which is what
 * these tests pin down.
 */

import { decodeFrame } from '../../../src/api/protobuf'
import { ObserveState } from '../../../src/state/observe-state'
import { buildInventory, listDevices } from '../../../src/state/registry'
import type { BucketMap } from '../../../src/types/nest'
import {
  buildFrame,
  heatingThermostatTraits,
  protectTraits,
  temperatureSensorTraits,
} from '../../helpers/observe-fixtures'

const THERMOSTAT_ID = 'THERM0001'
const PROTECT_ID = 'PROTECT01'
const OBSERVE_ONLY_PROTECT_ID = 'PROTECT99'
const SENSOR_ID = 'SENSOR001'

function observeWithEverything(): ObserveState {
  const state = new ObserveState()
  state.apply(decodeFrame(buildFrame([
    ...heatingThermostatTraits(`DEVICE_${THERMOSTAT_ID}`),
    ...protectTraits(`DEVICE_${PROTECT_ID}`),
    ...protectTraits(`DEVICE_${OBSERVE_ONLY_PROTECT_ID}`),
    ...temperatureSensorTraits(`DEVICE_${SENSOR_ID}`),
  ])).traits)
  return state
}

const buckets: BucketMap = {
  topaz: {
    [PROTECT_ID]: {
      serial_number: PROTECT_ID,
      model: 'Topaz-2.7',
      smoke_status: 0,
      co_status: 0,
      line_power_present: true,
      auto_away: false,
      where_id: 'where-hall',
    },
    // A Protect only REST knows about, mirroring an account where one device
    // has not yet moved to the protobuf backend.
    RESTONLY01: { serial_number: 'RESTONLY01', smoke_status: 0, co_status: 0, description: 'Garage Protect' },
  },
  kryptonite: {
    [SENSOR_ID]: { serial_number: SENSOR_ID, battery_level: 55, current_temperature: 19 },
  },
  where: {
    structure_1: { wheres: [{ where_id: 'where-hall', name: 'Hallway' }] },
  },
}

const empty = new Set<string>()

describe('buildInventory', () => {
  it('publishes devices only Observe reports', () => {
    // REST returns no thermostat buckets at all on a protobuf account, while
    // still claiming the home has several.
    const inventory = buildInventory({ observe: observeWithEverything(), buckets: {}, ignoredDeviceIds: empty })

    expect(inventory.thermostats.size).toBe(1)
    expect(inventory.protects.size).toBe(2)
    expect(inventory.temperatureSensors.size).toBe(1)
  })

  it('publishes devices only REST reports', () => {
    const inventory = buildInventory({ observe: new ObserveState(), buckets, ignoredDeviceIds: empty })

    expect([...inventory.protects.keys()].sort()).toEqual([PROTECT_ID, 'RESTONLY01'])
  })

  it('unions both transports without duplicating shared devices', () => {
    const inventory = buildInventory({ observe: observeWithEverything(), buckets, ignoredDeviceIds: empty })

    expect([...inventory.protects.keys()].sort())
      .toEqual([PROTECT_ID, OBSERVE_ONLY_PROTECT_ID, 'RESTONLY01'].sort())
  })

  it('records which transports contributed to each device', () => {
    const inventory = buildInventory({ observe: observeWithEverything(), buckets, ignoredDeviceIds: empty })

    expect(inventory.protects.get(PROTECT_ID)?.identity.sources).toEqual({ observe: true, rest: true })
    expect(inventory.protects.get(OBSERVE_ONLY_PROTECT_ID)?.identity.sources)
      .toEqual({ observe: true, rest: false })
    expect(inventory.protects.get('RESTONLY01')?.identity.sources)
      .toEqual({ observe: false, rest: true })
  })

  it('gives an Observe-only Protect working state and honest occupancy', () => {
    const inventory = buildInventory({ observe: observeWithEverything(), buckets, ignoredDeviceIds: empty })
    const device = inventory.protects.get(OBSERVE_ONLY_PROTECT_ID)

    expect(device?.state.isOnline).toBe(true)
    expect(device?.state.isBatteryLow).toBe(false)
    expect(device?.state.occupancySource).toBe('unavailable_observe_only')
    expect(device?.state.smoke).toBeUndefined()
  })

  it('combines REST alarm state with Observe liveness on a shared device', () => {
    const inventory = buildInventory({ observe: observeWithEverything(), buckets, ignoredDeviceIds: empty })
    const device = inventory.protects.get(PROTECT_ID)

    expect(device?.state.smoke).toBe('ok')
    expect(device?.state.isOnline).toBe(true)
    expect(device?.state.isOccupied).toBe(true)
    expect(device?.state.occupancySource).toBe('auto_away')
  })

  it('keys devices by bare hardware id, matching Observe and REST', () => {
    // The Observe prefix must be stripped, or the same Protect is published
    // twice and its HomeKit accessory changes identity when REST catches up.
    const inventory = buildInventory({ observe: observeWithEverything(), buckets, ignoredDeviceIds: empty })

    expect(inventory.protects.has(`DEVICE_${PROTECT_ID}`)).toBe(false)
    expect(inventory.protects.has(PROTECT_ID)).toBe(true)
  })

  it('classifies each device from the traits it reports', () => {
    const inventory = buildInventory({ observe: observeWithEverything(), buckets: {}, ignoredDeviceIds: empty })

    expect(inventory.thermostats.get(THERMOSTAT_ID)?.identity.kind).toBe('thermostat')
    expect(inventory.temperatureSensors.get(SENSOR_ID)?.identity.kind).toBe('temperature_sensor')
  })

  it('does not publish a Protect as a thermometer', () => {
    // A Protect reports a temperature trait too, so classification order is
    // what stops every smoke alarm in the house appearing as a thermometer.
    const inventory = buildInventory({ observe: observeWithEverything(), buckets: {}, ignoredDeviceIds: empty })

    expect(inventory.temperatureSensors.has(PROTECT_ID)).toBe(false)
  })

  it('prefers a user label over a room name', () => {
    const inventory = buildInventory({ observe: observeWithEverything(), buckets, ignoredDeviceIds: empty })

    expect(inventory.protects.get(PROTECT_ID)?.identity.name).toBe('Test Protect')
  })

  it('falls back to the REST description when Observe has no label', () => {
    const inventory = buildInventory({ observe: new ObserveState(), buckets, ignoredDeviceIds: empty })

    expect(inventory.protects.get('RESTONLY01')?.identity.name).toBe('Garage Protect')
  })

  it('names an unlabelled device after its room', () => {
    const inventory = buildInventory({
      observe: new ObserveState(),
      buckets: {
        ...buckets,
        topaz: { [PROTECT_ID]: { serial_number: PROTECT_ID, where_id: 'where-hall' } },
      },
      ignoredDeviceIds: empty,
    })

    expect(inventory.protects.get(PROTECT_ID)?.identity.name).toBe('Hallway Protect')
  })

  it('leaves out devices the user asked to ignore', () => {
    const inventory = buildInventory({
      observe: observeWithEverything(),
      buckets,
      ignoredDeviceIds: new Set([PROTECT_ID, THERMOSTAT_ID]),
    })

    expect(inventory.protects.has(PROTECT_ID)).toBe(false)
    expect(inventory.thermostats.size).toBe(0)
    expect(inventory.protects.has(OBSERVE_ONLY_PROTECT_ID)).toBe(true)
  })

  it('takes identity details from whichever transport has them', () => {
    const inventory = buildInventory({ observe: observeWithEverything(), buckets, ignoredDeviceIds: empty })
    const thermostat = inventory.thermostats.get(THERMOSTAT_ID)

    expect(thermostat?.identity.model).toBe('Nest Thermostat E')
    expect(thermostat?.identity.firmwareVersion).toBe('6.3-5')
    expect(thermostat?.identity.serialNumber).toBe('TSTAT0001')
  })

  it('merges a legacy thermostat across its shared and device buckets', () => {
    // A REST-only thermostat is split across two buckets: `shared` carries the
    // setpoints, `device` carries the room, serial, and model. Reading only the
    // first match dropped the room assignment, so the device was published as
    // "Thermostat 0001" instead of "Hallway Thermostat".
    const inventory = buildInventory({
      observe: new ObserveState(),
      buckets: {
        where: buckets.where!,
        shared: {
          [THERMOSTAT_ID]: {
            target_temperature_type: 'heat',
            target_temperature: 21,
            current_temperature: 19.5,
          },
        },
        device: {
          [THERMOSTAT_ID]: {
            serial_number: 'TSTAT-LEGACY',
            where_id: 'where-hall',
            model_version: 'Nest Learning Thermostat 3rd Gen',
            structure_id: 'structure_1',
          },
        },
      },
      ignoredDeviceIds: empty,
    })
    const thermostat = inventory.thermostats.get(THERMOSTAT_ID)

    expect(thermostat?.identity.name).toBe('Hallway Thermostat')
    expect(thermostat?.identity.serialNumber).toBe('TSTAT-LEGACY')
    expect(thermostat?.identity.whereId).toBe('where-hall')
    expect(thermostat?.identity.structureId).toBe('structure_1')
    expect(thermostat?.identity.model).toBe('Nest Learning Thermostat 3rd Gen')
    expect(thermostat?.state.targetTemperatureC).toBe(21)
  })

  it('returns an empty inventory when neither transport has reported', () => {
    const inventory = buildInventory({ observe: new ObserveState(), buckets: {}, ignoredDeviceIds: empty })

    expect(listDevices(inventory)).toEqual([])
  })
})

describe('listDevices', () => {
  it('returns every device across all three kinds', () => {
    const devices = listDevices(
      buildInventory({ observe: observeWithEverything(), buckets, ignoredDeviceIds: empty }),
    )

    expect(devices).toHaveLength(5)
    expect(new Set(devices.map((device) => device.identity.kind)))
      .toEqual(new Set(['thermostat', 'protect', 'temperature_sensor']))
  })
})
