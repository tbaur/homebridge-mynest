/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The Homebridge 2 live-update path.
 *
 * This is the behaviour the plugin exists to get right, so the tests are
 * written against the real HAP implementation and assert the specific failure
 * modes that shipped in the community plugin: reading through the removed
 * `getValue()`, and pushing back the cached `.value` so nothing ever changes.
 */

import { Characteristic, Service, createAccessory } from '../../helpers/hap'
import { createRecordingLogger } from '../../helpers/logger'
import { CharacteristicBinder } from '../../../src/utils/bound-characteristics'

describe('CharacteristicBinder', () => {
  const setup = () => {
    const accessory = createAccessory('Test Thermostat')
    const service = accessory.addService(Service.Thermostat as never) as unknown as Service
    const log = createRecordingLogger()
    return { accessory, service, log, binder: new CharacteristicBinder(log) }
  }

  it('pushes a recomputed value, not the cached one', () => {
    const { service, binder } = setup()
    let temperature = 18

    // Binding registers the reader; publishing is `refresh`'s job, which is why
    // every accessory calls it once after wiring itself up.
    binder.bind(service as never, Characteristic.CurrentTemperature as never, () => temperature)
    binder.refresh()
    expect(service.getCharacteristic(Characteristic.CurrentTemperature).value).toBe(18)

    // The 4.6.10 regression: `updateValue(characteristic.value)` writes back
    // what HomeKit already had, so the reading never moves again. A binder that
    // re-reads picks the new value up.
    temperature = 23.5
    binder.refresh()

    expect(service.getCharacteristic(Characteristic.CurrentTemperature).value).toBe(23.5)
  })

  it('notifies subscribers when a pushed value changes', () => {
    const { service, binder } = setup()
    let temperature = 18
    binder.bind(service as never, Characteristic.CurrentTemperature as never, () => temperature)

    const changes: unknown[] = []
    service.getCharacteristic(Characteristic.CurrentTemperature)
      .on('change', ({ newValue }) => changes.push(newValue))

    temperature = 21
    binder.refresh()

    expect(changes).toEqual([21])
  })

  it('never calls the removed getValue()', () => {
    const { service, binder } = setup()
    const characteristic = service.getCharacteristic(Characteristic.CurrentTemperature)

    // Homebridge 2 removes this entirely; a plugin that still calls it crashes
    // at boot, which is what 4.6.9 did.
    const removed = jest.fn(() => {
      throw new Error('getValue() does not exist on HAP 2')
    })
    ;(characteristic as unknown as { getValue: unknown }).getValue = removed

    binder.bind(service as never, Characteristic.CurrentTemperature as never, () => 20)
    binder.refresh()

    expect(removed).not.toHaveBeenCalled()
    expect(characteristic.value).toBe(20)
  })

  it('leaves the last known value in place when a reader has no answer', () => {
    const { service, binder } = setup()
    let temperature: number | undefined = 20

    binder.bind(service as never, Characteristic.CurrentTemperature as never, () => temperature)
    binder.refresh()

    // A trait Nest stopped reporting must not become 0 °C in the Home app.
    temperature = undefined
    binder.refresh()

    expect(service.getCharacteristic(Characteristic.CurrentTemperature).value).toBe(20)
  })

  it('keeps updating the rest of the accessory when one reader throws', () => {
    const { service, log, binder } = setup()

    binder.bind(service as never, Characteristic.CurrentTemperature as never, () => {
      throw new Error('bad mapping')
    })
    binder.bind(service as never, Characteristic.TargetTemperature as never, () => 22)

    binder.refresh()

    expect(service.getCharacteristic(Characteristic.TargetTemperature).value).toBe(22)
    expect(log.debugs.join('\n')).toContain('bad mapping')
  })

  it('answers a direct HomeKit read from the same reader as a push', async () => {
    const { service, binder } = setup()
    let temperature = 15
    binder.bind(service as never, Characteristic.CurrentTemperature as never, () => temperature)

    temperature = 17
    const characteristic = service.getCharacteristic(Characteristic.CurrentTemperature)

    await expect(characteristic.handleGetRequest()).resolves.toBe(17)
  })

  it('routes a HomeKit write to the device only when one is bound', async () => {
    const { service, binder } = setup()
    const write = jest.fn().mockResolvedValue(undefined)

    binder.bind(service as never, Characteristic.TargetTemperature as never, () => 20, { write })
    await service.getCharacteristic(Characteristic.TargetTemperature).handleSetRequest(24)

    expect(write).toHaveBeenCalledWith(24)
  })

  it('counts every binding it holds', () => {
    const { service, binder } = setup()
    binder.bind(service as never, Characteristic.CurrentTemperature as never, () => 1)
    binder.bind(service as never, Characteristic.TargetTemperature as never, () => 2)

    expect(binder.size).toBe(2)
  })

  it('replaces the reader when the same characteristic is bound again', () => {
    const { service, binder } = setup()
    let temperature = 18

    binder.bind(service as never, Characteristic.CurrentTemperature as never, () => 10)
    binder.bind(service as never, Characteristic.CurrentTemperature as never, () => temperature)
    temperature = 22
    binder.refresh()

    expect(binder.size).toBe(1)
    expect(service.getCharacteristic(Characteristic.CurrentTemperature).value).toBe(22)
  })

  it('drops bindings for a service that is about to be removed', () => {
    const { accessory, service, binder } = setup()
    binder.bind(service as never, Characteristic.CurrentTemperature as never, () => 20)
    expect(binder.size).toBe(1)

    binder.unbindService(service as never)
    accessory.removeService(service as never)

    expect(binder.size).toBe(0)
    expect(() => binder.refresh()).not.toThrow()
  })
})
