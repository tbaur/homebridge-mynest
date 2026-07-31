/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The Nest Temperature Sensor accessory.
 */

import { TemperatureSensorAccessory } from '../../../src/accessories/temperature-sensor'
import type { DeviceOfKind, TemperatureSensorState } from '../../../src/types/device'
import {
  Characteristic,
  Service,
  createAccessory,
  createPlatformStub,
  readValue,
} from '../../helpers/hap'
import { createRecordingLogger } from '../../helpers/logger'

function build(state: TemperatureSensorState) {
  const platform = createPlatformStub()
  const accessory = createAccessory('Study Sensor')
  const log = createRecordingLogger()

  const device: DeviceOfKind<'temperature_sensor'> = {
    identity: {
      id: 'SENSOR01',
      kind: 'temperature_sensor',
      name: 'Study Sensor',
      sources: { observe: true, rest: true },
      model: 'KR1',
      serialNumber: 'SENSOR01',
    },
    state,
  }

  const handler = new TemperatureSensorAccessory(platform, accessory, device, log)
  const read = (serviceType: unknown, type: unknown): unknown =>
    readValue(accessory, serviceType, type)

  return { handler, accessory, log, read, device }
}

describe('TemperatureSensorAccessory', () => {
  it('publishes the temperature', () => {
    const { read } = build({ temperatureC: 18.2, batteryLevel: 80, isBatteryLow: false })

    // HomeKit quantises to 0.1 °C, so the fixture sits on that grid; a Nest
    // reading with more precision arrives rounded, which is HAP's business.
    expect(read(Service.TemperatureSensor, Characteristic.CurrentTemperature))
      .toBeCloseTo(18.2, 5)
  })

  it('publishes a battery service so the level is visible in the Home app', () => {
    const { read } = build({ temperatureC: 18, batteryLevel: 80, isBatteryLow: false })

    expect(read(Service.Battery, Characteristic.BatteryLevel)).toBe(80)
    expect(read(Service.Battery, Characteristic.StatusLowBattery))
      .toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)
  })

  it('reports the cell as not chargeable, which it is not', () => {
    const { read } = build({ temperatureC: 18 })

    expect(read(Service.Battery, Characteristic.ChargingState))
      .toBe(Characteristic.ChargingState.NOT_CHARGEABLE)
  })

  it('warns on both services when the battery is low', () => {
    const { read } = build({ temperatureC: 18, batteryLevel: 12, isBatteryLow: true })

    expect(read(Service.TemperatureSensor, Characteristic.StatusLowBattery))
      .toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW)
    expect(read(Service.Battery, Characteristic.StatusLowBattery))
      .toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW)
  })

  it('pushes a new reading into HomeKit', () => {
    const { handler, read, device } = build({ temperatureC: 18 })

    handler.update({ ...device, state: { temperatureC: 21.5, batteryLevel: 60 } })

    expect(read(Service.TemperatureSensor, Characteristic.CurrentTemperature)).toBe(21.5)
    expect(read(Service.Battery, Characteristic.BatteryLevel)).toBe(60)
  })

  it('keeps the last reading when the sensor goes quiet', () => {
    const { handler, read, device } = build({ temperatureC: 18 })

    handler.update({ ...device, state: {} })

    expect(read(Service.TemperatureSensor, Characteristic.CurrentTemperature)).toBe(18)
  })

  it('summarises its state, quietly at first and aloud on a change', () => {
    const { handler, log, device } = build({ temperatureC: 18 })

    handler.update({ ...device, state: { temperatureC: 18, batteryLevel: 60 } })
    expect(log.infos).toEqual([])
    expect(log.debugs.join('\n')).toContain('18.0')

    handler.update({ ...device, state: { temperatureC: 21.5, batteryLevel: 60 } })
    expect(log.infos.join('\n')).toContain('21.5')
    expect(log.infos.join('\n')).toContain('Battery 60%')
  })
})
