/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The Protect accessory.
 *
 * The occupancy behaviour is the part that matters. Nest publishes a
 * ten-minute presence verdict, not motion, and omitted for a battery-powered Protect, so
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
  const accessory = createAccessory('Zone One Protect')
  const log = createRecordingLogger()

  const device: DeviceOfKind<'protect'> = {
    identity: {
      id: 'PROTECT01',
      kind: 'protect',
      name: 'Zone One Protect',
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
  beforeEach(() => {
    ProtectAccessory.resetOccupancyHintForTests()
  })

  it('publishes a smoke and a CO sensor', async () => {
    const { accessory, read } = build(clear)

    expect(read(Service.SmokeSensor, Characteristic.SmokeDetected))
      .toBe(Characteristic.SmokeDetected.SMOKE_NOT_DETECTED)
    expect(read(Service.CarbonMonoxideSensor, Characteristic.CarbonMonoxideDetected))
      .toBe(Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL)

    const smoke = accessory.getService(Service.SmokeSensor)!
      .getCharacteristic(Characteristic.SmokeDetected)
    await expect(smoke.handleGetRequest()).resolves.toBe(
      Characteristic.SmokeDetected.SMOKE_NOT_DETECTED,
    )
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

  it('faults the sensor Nest did not report', () => {
    // Nest returns different topaz subsets per firmware. A bucket with
    // smoke_status and no co_status still has a CO tile, inactive, so HomeKit
    // does not treat HAP's default "levels normal" as a live clear.
    const { accessory, read } = build({
      ...clear,
      smoke: 'ok',
      carbonMonoxide: undefined,
    })

    expect(hasService(accessory, Service.SmokeSensor)).toBe(true)
    expect(hasService(accessory, Service.CarbonMonoxideSensor)).toBe(true)
    expect(read(Service.SmokeSensor, Characteristic.SmokeDetected))
      .toBe(Characteristic.SmokeDetected.SMOKE_NOT_DETECTED)
    expect(read(Service.SmokeSensor, Characteristic.StatusActive)).toBe(true)
    expect(read(Service.CarbonMonoxideSensor, Characteristic.StatusActive)).toBe(false)
    expect(read(Service.CarbonMonoxideSensor, Characteristic.StatusFault))
      .toBe(Characteristic.StatusFault.GENERAL_FAULT)
  })

  it('faults smoke when Nest reported CO alone', () => {
    const { accessory, read } = build({ ...clear, smoke: undefined, carbonMonoxide: 'ok' })

    expect(hasService(accessory, Service.SmokeSensor)).toBe(true)
    expect(hasService(accessory, Service.CarbonMonoxideSensor)).toBe(true)
    expect(read(Service.SmokeSensor, Characteristic.StatusActive)).toBe(false)
    expect(read(Service.CarbonMonoxideSensor, Characteristic.StatusActive)).toBe(true)
  })

  it('keeps a sensor and faults it when Nest stops reporting that level', () => {
    const { handler, accessory, device, read } = build(clear)

    expect(hasService(accessory, Service.CarbonMonoxideSensor)).toBe(true)

    handler.update({ ...device, state: { ...clear, carbonMonoxide: undefined } })

    expect(hasService(accessory, Service.SmokeSensor)).toBe(true)
    expect(hasService(accessory, Service.CarbonMonoxideSensor)).toBe(true)
    expect(read(Service.CarbonMonoxideSensor, Characteristic.StatusActive)).toBe(false)
    expect(read(Service.CarbonMonoxideSensor, Characteristic.StatusFault))
      .toBe(Characteristic.StatusFault.GENERAL_FAULT)
    expect(read(Service.SmokeSensor, Characteristic.StatusActive)).toBe(true)
  })

  it('publishes faulted smoke and CO sensors when alarm state is unknown', async () => {
    const { accessory, log, read } = build({
      occupancySource: 'unavailable_observe_only',
      isBatteryLow: false,
    })

    expect(hasService(accessory, Service.SmokeSensor)).toBe(true)
    expect(hasService(accessory, Service.CarbonMonoxideSensor)).toBe(true)
    expect(hasService(accessory, Service.Battery)).toBe(false)
    expect(read(Service.SmokeSensor, Characteristic.StatusActive)).toBe(false)
    expect(read(Service.SmokeSensor, Characteristic.StatusFault))
      .toBe(Characteristic.StatusFault.GENERAL_FAULT)
    expect(log.infos.join('\n')).toMatch(/no smoke\/CO reading yet/)

    const smoke = accessory.getService(Service.SmokeSensor)!
      .getCharacteristic(Characteristic.SmokeDetected)
    await expect(smoke.handleGetRequest()).resolves.toBe(
      Characteristic.SmokeDetected.SMOKE_NOT_DETECTED,
    )
  })

  it('keeps a cached smoke detection when Nest later omits the number', async () => {
    const { accessory, handler, device } = build({
      ...clear,
      smoke: 'emergency',
      carbonMonoxide: 'emergency',
    })
    const smoke = accessory.getService(Service.SmokeSensor)!
      .getCharacteristic(Characteristic.SmokeDetected)
    const carbonMonoxide = accessory.getService(Service.CarbonMonoxideSensor)!
      .getCharacteristic(Characteristic.CarbonMonoxideDetected)

    handler.update({
      ...device,
      state: { ...clear, smoke: undefined, carbonMonoxide: undefined },
    })

    await expect(smoke.handleGetRequest()).resolves.toBe(
      Characteristic.SmokeDetected.SMOKE_DETECTED,
    )
    await expect(carbonMonoxide.handleGetRequest()).resolves.toBe(
      Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL,
    )
    smoke.iid = 1
    const listed = await smoke.toHAP(undefined as never, true)
    expect(listed.value).toBe(Characteristic.SmokeDetected.SMOKE_DETECTED)
    expect(accessory.getService(Service.SmokeSensor)!
      .getCharacteristic(Characteristic.StatusActive).value).toBe(false)
  })

  it('keeps a cached low battery when Nest later omits the verdict', async () => {
    const { accessory, handler, device } = build({ ...clear, isBatteryLow: true })
    const battery = accessory.getService(Service.SmokeSensor)!
      .getCharacteristic(Characteristic.StatusLowBattery)

    handler.update({ ...device, state: { ...clear, isBatteryLow: undefined } })

    await expect(battery.handleGetRequest()).resolves.toBe(
      Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    )
    battery.iid = 2
    const listed = await battery.toHAP(undefined as never, true)
    expect(listed.value).toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW)
  })

  it('marks smoke and CO live when REST alarm state arrives later', () => {
    const { handler, accessory, device, read } = build({
      occupancySource: 'unavailable_observe_only',
      isBatteryLow: false,
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
    expect(log.debugs.join('\n')).toMatch(/smoke\/CO marked inactive/)
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
    expect(log.debugs.join('\n')).toMatch(/smoke\/CO live again/)
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

  it('reports an offline clear Protect as inactive and faulted', () => {
    const { read } = build({ ...clear, isOnline: false })

    expect(read(Service.SmokeSensor, Characteristic.StatusActive)).toBe(false)
    expect(read(Service.SmokeSensor, Characteristic.StatusFault))
      .toBe(Characteristic.StatusFault.GENERAL_FAULT)
  })

  it('keeps a fresh smoke alarm active when Observe says the Protect is offline', () => {
    const { read } = build({
      ...clear,
      isOnline: false,
      smoke: 'emergency',
      carbonMonoxide: 'ok',
    })

    expect(read(Service.SmokeSensor, Characteristic.SmokeDetected))
      .toBe(Characteristic.SmokeDetected.SMOKE_DETECTED)
    expect(read(Service.SmokeSensor, Characteristic.StatusActive)).toBe(true)
    expect(read(Service.SmokeSensor, Characteristic.StatusFault))
      .toBe(Characteristic.StatusFault.NO_FAULT)
    expect(read(Service.CarbonMonoxideSensor, Characteristic.StatusActive)).toBe(false)
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

  it('logs once that occupancy is presence, not motion', () => {
    const platform = createPlatformStub()
    const log = createRecordingLogger()
    const make = (name: string, id: string) => {
      const accessory = createAccessory(name)
      const device: DeviceOfKind<'protect'> = {
        identity: {
          id,
          kind: 'protect',
          name,
          sources: { observe: true, rest: true },
          model: 'Topaz-2.7',
          serialNumber: id,
        },
        state: clear,
      }
      return new ProtectAccessory(platform, accessory, device, log)
    }

    make('Zone One Protect', 'PROTECT01')
    make('Zone Two Protect', 'PROTECT02')

    const hints = log.infos.filter((line) => line.includes('Protect occupancy'))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toMatch(/auto-away \(about 10 min\), not motion/)
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
    expect(log.infos.join('\n')).toContain('battery powered')
  })

  it('publishes no occupancy sensor for a Protect missing from REST', () => {
    const { accessory, log } = build({
      ...clear,
      isOccupied: undefined,
      occupancySource: 'unavailable_observe_only',
    })

    expect(hasService(accessory, Service.OccupancySensor)).toBe(false)
    expect(log.infos.join('\n')).toContain('REST')
  })

  it('respects the user turning occupancy off', () => {
    const { accessory, log } = build(clear, { exposeProtectOccupancy: false })

    expect(hasService(accessory, Service.OccupancySensor)).toBe(false)
    expect(log.infos.join('\n')).toContain('turned off in settings')
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

    // First summary is announced, so an operator can see the device reporting.
    handler.update({ ...device, state: clear })
    expect(log.infos.join('\n')).toContain('Smoke ok')

    log.infos.length = 0
    handler.update({ ...device, state: clear })
    expect(log.infos.filter((line) => line.includes('Smoke'))).toEqual([])

    handler.update({ ...device, state: { ...clear, smoke: 'emergency' } })
    expect(log.infos.join('\n')).toContain('Smoke emergency')
  })
})
