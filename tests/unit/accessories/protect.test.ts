/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The Protect accessory.
 *
 * The occupancy behaviour is the part that matters. Nest publishes a
 * ten-minute presence verdict, not motion, and only for mains-powered units, so
 * these tests pin down both what is published and what deliberately is not.
 */

import { ProtectAccessory } from '../../../src/accessories/protect'
import type { DeviceOfKind, ProtectState } from '../../../src/types/device'
import {
  Characteristic,
  Service,
  createAccessory,
  createPlatformStub,
  hasService,
  readValue,
} from '../../helpers/hap'
import { createRecordingLogger } from '../../helpers/logger'
import type { ResolvedConfig } from '../../../src/types/config'

function build(state: ProtectState, config: Partial<ResolvedConfig> = {}) {
  const platform = createPlatformStub(config)
  const accessory = createAccessory('Hallway Protect')
  const log = createRecordingLogger()

  const device: DeviceOfKind<'protect'> = {
    identity: {
      id: 'PROTECT01',
      kind: 'protect',
      name: 'Hallway Protect',
      sources: { observe: true, rest: true },
      model: 'Topaz-2.7',
      serialNumber: 'PROTECT01',
    },
    state,
  }

  const handler = new ProtectAccessory(platform, accessory, device, log)
  const read = (serviceType: unknown, type: unknown): unknown =>
    readValue(accessory, serviceType, type)

  return { handler, accessory, log, read, device }
}

const clear: ProtectState = {
  smoke: 'ok',
  carbonMonoxide: 'ok',
  isBatteryLow: false,
  isOnline: true,
  isLinePowered: true,
  isOccupied: true,
  occupancySource: 'auto_away',
}

describe('ProtectAccessory', () => {
  it('publishes a smoke and a CO sensor', () => {
    const { read } = build(clear)

    expect(read(Service.SmokeSensor, Characteristic.SmokeDetected))
      .toBe(Characteristic.SmokeDetected.SMOKE_NOT_DETECTED)
    expect(read(Service.CarbonMonoxideSensor, Characteristic.CarbonMonoxideDetected))
      .toBe(Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL)
  })

  it('raises the alarm for an emergency', () => {
    const { read } = build({ ...clear, smoke: 'emergency', carbonMonoxide: 'emergency' })

    expect(read(Service.SmokeSensor, Characteristic.SmokeDetected))
      .toBe(Characteristic.SmokeDetected.SMOKE_DETECTED)
    expect(read(Service.CarbonMonoxideSensor, Characteristic.CarbonMonoxideDetected))
      .toBe(Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL)
  })

  it('raises the alarm for a heads-up too', () => {
    // Nest's middle level is "enough smoke to mention". On a life-safety
    // device, an alert nobody needed beats a real one HomeKit stayed quiet
    // about.
    const { read } = build({ ...clear, smoke: 'warning', carbonMonoxide: 'warning' })

    expect(read(Service.SmokeSensor, Characteristic.SmokeDetected))
      .toBe(Characteristic.SmokeDetected.SMOKE_DETECTED)
    expect(read(Service.CarbonMonoxideSensor, Characteristic.CarbonMonoxideDetected))
      .toBe(Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL)
  })

  it('publishes no smoke or CO sensor when alarm state is unknown', () => {
    // HAP's default for SmokeDetected is "not detected". Creating the service
    // would show a working all-clear on no evidence, so Observe-only Protects
    // get neither tile until REST reports alarm state.
    const { accessory, log } = build({
      occupancySource: 'unavailable_observe_only',
      isBatteryLow: false,
    })

    expect(hasService(accessory, Service.SmokeSensor)).toBe(false)
    expect(hasService(accessory, Service.CarbonMonoxideSensor)).toBe(false)
    expect(hasService(accessory, Service.Battery)).toBe(true)
    expect(log.infos.join('\n')).toContain('no smoke/CO')
  })

  it('grows smoke and CO sensors when REST alarm state arrives later', () => {
    const { handler, accessory, device, read } = build({
      occupancySource: 'unavailable_observe_only',
      isBatteryLow: false,
    })

    expect(hasService(accessory, Service.SmokeSensor)).toBe(false)

    handler.update({
      ...device,
      state: {
        ...clear,
        smoke: 'ok',
        carbonMonoxide: 'ok',
        occupancySource: 'auto_away',
        isOccupied: true,
      },
    })

    expect(hasService(accessory, Service.SmokeSensor)).toBe(true)
    expect(hasService(accessory, Service.CarbonMonoxideSensor)).toBe(true)
    expect(hasService(accessory, Service.Battery)).toBe(false)
    expect(read(Service.SmokeSensor, Characteristic.SmokeDetected))
      .toBe(Characteristic.SmokeDetected.SMOKE_NOT_DETECTED)
  })

  it('keeps smoke and CO but marks them inactive when the REST alarm feed goes stale', () => {
    const { handler, accessory, device, log, read } = build(clear)

    expect(hasService(accessory, Service.SmokeSensor)).toBe(true)

    handler.update({
      ...device,
      state: {
        ...clear,
        isAlarmFeedStale: true,
        occupancySource: 'unavailable_rest_stale',
        isOnline: true,
        isBatteryLow: false,
      },
    })

    expect(hasService(accessory, Service.SmokeSensor)).toBe(true)
    expect(hasService(accessory, Service.CarbonMonoxideSensor)).toBe(true)
    expect(hasService(accessory, Service.Battery)).toBe(false)
    expect(read(Service.SmokeSensor, Characteristic.SmokeDetected))
      .toBe(Characteristic.SmokeDetected.SMOKE_NOT_DETECTED)
    expect(read(Service.SmokeSensor, Characteristic.StatusActive)).toBe(false)
    expect(read(Service.SmokeSensor, Characteristic.StatusFault))
      .toBe(Characteristic.StatusFault.GENERAL_FAULT)
    expect(hasService(accessory, Service.OccupancySensor)).toBe(true)
    expect(read(Service.OccupancySensor, Characteristic.StatusActive)).toBe(false)
    expect(log.warns.join('\n')).toMatch(/kept in HomeKit but marked inactive/i)
  })

  it('marks smoke and CO live again when the REST alarm feed recovers', () => {
    const { handler, accessory, device, log, read } = build({
      ...clear,
      isAlarmFeedStale: true,
      occupancySource: 'unavailable_rest_stale',
    })

    expect(read(Service.SmokeSensor, Characteristic.StatusActive)).toBe(false)

    handler.update({
      ...device,
      state: {
        ...clear,
        smoke: 'ok',
        carbonMonoxide: 'ok',
        occupancySource: 'auto_away',
        isOccupied: true,
      },
    })

    expect(hasService(accessory, Service.SmokeSensor)).toBe(true)
    expect(read(Service.SmokeSensor, Characteristic.StatusActive)).toBe(true)
    expect(read(Service.SmokeSensor, Characteristic.StatusFault))
      .toBe(Characteristic.StatusFault.NO_FAULT)
    expect(log.infos.join('\n')).toMatch(/smoke\/CO are live again/i)
  })

  it('grows an occupancy sensor when REST auto_away arrives later', () => {
    const { handler, accessory, device } = build({
      ...clear,
      isOccupied: undefined,
      occupancySource: 'unavailable_observe_only',
    })

    expect(hasService(accessory, Service.OccupancySensor)).toBe(false)

    handler.update({
      ...device,
      state: { ...clear, isOccupied: true, occupancySource: 'auto_away' },
    })

    expect(hasService(accessory, Service.OccupancySensor)).toBe(true)
  })

  it('reports an offline Protect as inactive and faulted', () => {
    const { read } = build({ ...clear, isOnline: false })

    expect(read(Service.SmokeSensor, Characteristic.StatusActive)).toBe(false)
    expect(read(Service.SmokeSensor, Characteristic.StatusFault))
      .toBe(Characteristic.StatusFault.GENERAL_FAULT)
  })

  it('reports a flat battery on both sensors', () => {
    const { read } = build({ ...clear, isBatteryLow: true })

    expect(read(Service.SmokeSensor, Characteristic.StatusLowBattery))
      .toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW)
    expect(read(Service.CarbonMonoxideSensor, Characteristic.StatusLowBattery))
      .toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW)
  })

  it('publishes occupancy when Nest computes it', () => {
    const { read } = build(clear)

    expect(read(Service.OccupancySensor, Characteristic.OccupancyDetected))
      .toBe(Characteristic.OccupancyDetected.OCCUPANCY_DETECTED)
  })

  it('reports an empty house', () => {
    const { read } = build({ ...clear, isOccupied: false })

    expect(read(Service.OccupancySensor, Characteristic.OccupancyDetected))
      .toBe(Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED)
  })

  it('says in the log that occupancy is presence, not motion', () => {
    // Anyone building an automation on this needs to know it will not react to
    // someone walking past.
    const { log } = build(clear)

    expect(log.infos.join('\n')).toContain('not motion')
    expect(log.infos.join('\n')).toContain('10-minute')
  })

  it('publishes no occupancy sensor for a battery-powered Protect', () => {
    // A sensor stuck at "not occupied" looks like a working sensor reporting an
    // empty house forever.
    const { accessory, log } = build({
      ...clear,
      isOccupied: undefined,
      occupancySource: 'unsupported_battery_powered',
    })

    expect(hasService(accessory, Service.OccupancySensor)).toBe(false)
    expect(log.debugs.join('\n')).toContain('battery-powered')
  })

  it('publishes no occupancy sensor for a Protect missing from REST', () => {
    const { accessory, log } = build({
      ...clear,
      isOccupied: undefined,
      occupancySource: 'unavailable_observe_only',
    })

    expect(hasService(accessory, Service.OccupancySensor)).toBe(false)
    expect(log.debugs.join('\n')).toContain('REST')
  })

  it('respects the user turning occupancy off', () => {
    const { accessory } = build(clear, { exposeProtectOccupancy: false })

    expect(hasService(accessory, Service.OccupancySensor)).toBe(false)
  })

  it('publishes temperature and humidity when asked and available', () => {
    const { read } = build({ ...clear, temperatureC: 20.5, humidity: 45 }, {
      exposeProtectTemperature: true,
    })

    expect(read(Service.TemperatureSensor, Characteristic.CurrentTemperature)).toBe(20.5)
    // Humidity belongs to its own HomeKit service, not the temperature one.
    expect(read(Service.HumiditySensor, Characteristic.CurrentRelativeHumidity)).toBe(45)
  })

  it('publishes no humidity sensor when the Protect reports none', () => {
    const { accessory } = build({ ...clear, temperatureC: 20.5 }, {
      exposeProtectTemperature: true,
    })

    expect(hasService(accessory, Service.HumiditySensor)).toBe(false)
  })

  it('publishes no temperature sensor when the option is off', () => {
    const { accessory } = build({ ...clear, temperatureC: 20.5 }, {
      exposeProtectTemperature: false,
    })

    expect(hasService(accessory, Service.TemperatureSensor)).toBe(false)
  })

  it('publishes no temperature sensor when the device reports none', () => {
    const { accessory } = build(clear, { exposeProtectTemperature: true })

    expect(hasService(accessory, Service.TemperatureSensor)).toBe(false)
  })

  it('pushes new alarm state into HomeKit', () => {
    const { handler, read, device } = build(clear)

    handler.update({ ...device, state: { ...clear, smoke: 'emergency', isOccupied: false } })

    expect(read(Service.SmokeSensor, Characteristic.SmokeDetected))
      .toBe(Characteristic.SmokeDetected.SMOKE_DETECTED)
    expect(read(Service.OccupancySensor, Characteristic.OccupancyDetected))
      .toBe(Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED)
  })

  it('logs a state change once, then stays quiet', () => {
    const { handler, log, device } = build(clear)

    handler.update({ ...device, state: clear })
    expect(log.infos.filter((line) => line.includes('Smoke'))).toEqual([])

    handler.update({ ...device, state: { ...clear, smoke: 'emergency' } })
    expect(log.infos.join('\n')).toContain('Smoke emergency')
  })
})
