/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview House-wide Eco Mode switch HomeKit behaviour.
 */

import { GlobalEcoAccessory } from '../../../src/accessories/global-eco'
import { Characteristic, Service, createAccessory, createPlatformStub } from '../../helpers/hap'
import { createRecordingLogger } from '../../helpers/logger'

function build(options: { allowThermostatControl?: boolean } = {}) {
  const platform = createPlatformStub({
    allowThermostatControl: options.allowThermostatControl ?? true,
  })
  const accessory = createAccessory('Nest Eco Mode')
  const log = createRecordingLogger()
  const handler = new GlobalEcoAccessory(platform, accessory, log)
  const service = accessory.getService(Service.Switch as never)!
  return { handler, accessory, service, platform, log }
}

describe('GlobalEcoAccessory', () => {
  it('publishes a Switch named Nest Eco Mode', () => {
    const { service } = build()
    expect(service.getCharacteristic(Characteristic.Name).value).toBe('Nest Eco Mode')
    expect(service.getCharacteristic(Characteristic.On).value).toBe(false)
  })

  it('reflects all-Eco Nest state from the platform sync', () => {
    const { handler, service } = build()
    handler.updateAllEco(true)
    expect(service.getCharacteristic(Characteristic.On).value).toBe(true)
  })

  it('keeps On after a successful global Eco write (no stale refresh)', async () => {
    const { service, platform, log } = build()
    jest.spyOn(platform, 'applyGlobalEcoWrite').mockResolvedValue(true)

    await service.getCharacteristic(Characteristic.On).handleSetRequest(true)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(service.getCharacteristic(Characteristic.On).value).toBe(true)
    expect(log.infos.join('\n')).toMatch(/Updating all thermostats to Eco/)
  })

  it('keeps optimistic On across interim Nest syncs until all thermostats match', async () => {
    const { service, platform, handler } = build()
    jest.spyOn(platform, 'applyGlobalEcoWrite').mockResolvedValue(true)

    await service.getCharacteristic(Characteristic.On).handleSetRequest(true)

    // Staggered Eco confirms / unrelated inventory traffic.
    handler.updateAllEco(false)
    expect(service.getCharacteristic(Characteristic.On).value).toBe(true)

    handler.updateAllEco(true)
    expect(service.getCharacteristic(Characteristic.On).value).toBe(true)

    // After Nest confirms, a real all-clear must still be able to turn it off.
    handler.updateAllEco(false)
    expect(service.getCharacteristic(Characteristic.On).value).toBe(false)
  })

  it('follows Nest when Eco never confirms within the pending window', async () => {
    jest.useFakeTimers()
    try {
      const { service, platform, handler, log } = build()
      jest.spyOn(platform, 'applyGlobalEcoWrite').mockResolvedValue(true)

      await service.getCharacteristic(Characteristic.On).handleSetRequest(true)
      handler.updateAllEco(false)
      expect(service.getCharacteristic(Characteristic.On).value).toBe(true)

      jest.advanceTimersByTime(45_000)
      handler.updateAllEco(false)

      expect(service.getCharacteristic(Characteristic.On).value).toBe(false)
      expect(log.warns.join('\n')).toMatch(/did not confirm Eco change/)
    } finally {
      jest.useRealTimers()
    }
  })

  it('reverts On when control is off', async () => {
    const { service, platform, log, handler } = build({ allowThermostatControl: false })
    handler.updateAllEco(false)
    jest.spyOn(platform, 'applyGlobalEcoWrite').mockResolvedValue(false)

    await service.getCharacteristic(Characteristic.On).handleSetRequest(true)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(service.getCharacteristic(Characteristic.On).value).toBe(false)
    expect(log.warns.join('\n')).toMatch(/enable Allow thermostat control/)
  })

  it('reverts On when Nest rejects the write', async () => {
    const { service, platform, handler } = build()
    handler.updateAllEco(false)
    jest.spyOn(platform, 'applyGlobalEcoWrite').mockRejectedValue(new Error('Nest 503'))

    await service.getCharacteristic(Characteristic.On).handleSetRequest(true)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(service.getCharacteristic(Characteristic.On).value).toBe(false)
  })
})
