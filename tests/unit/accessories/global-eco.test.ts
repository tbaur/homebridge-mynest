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
    expect(log.infos.join('\n')).toMatch(/Eco on for all thermostats/)
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
      handler.updateAllEco(false)

      await service.getCharacteristic(Characteristic.On).handleSetRequest(true)
      handler.updateAllEco(false)
      expect(service.getCharacteristic(Characteristic.On).value).toBe(true)

      jest.advanceTimersByTime(45_000)

      expect(service.getCharacteristic(Characteristic.On).value).toBe(false)
      expect(log.warns.join('\n')).toMatch(/not confirmed in 45s, showing Nest state/)
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not call an unconfirmed command the last Nest reading', async () => {
    jest.useFakeTimers()
    try {
      const { service, platform, log } = build()
      jest.spyOn(platform, 'applyGlobalEcoWrite').mockResolvedValue(true)

      await service.getCharacteristic(Characteristic.On).handleSetRequest(true)
      jest.advanceTimersByTime(45_000)

      expect(service.getCharacteristic(Characteristic.On).value).toBe(true)
      expect(log.warns.join('\n')).toMatch(/not confirmed in 45s$/)
    } finally {
      jest.useRealTimers()
    }
  })

  it('expires to a Nest aggregate that arrived during the pending window', async () => {
    jest.useFakeTimers()
    try {
      const { service, platform, handler, log } = build()
      jest.spyOn(platform, 'applyGlobalEcoWrite').mockResolvedValue(true)

      await service.getCharacteristic(Characteristic.On).handleSetRequest(true)
      handler.updateAllEco(false)
      expect(service.getCharacteristic(Characteristic.On).value).toBe(true)

      jest.advanceTimersByTime(45_000)

      expect(service.getCharacteristic(Characteristic.On).value).toBe(false)
      expect(log.warns.join('\n')).toMatch(/showing Nest state/)
    } finally {
      jest.useRealTimers()
    }
  })

  it('expires to the latest Nest aggregate after a second toggle', async () => {
    jest.useFakeTimers()
    try {
      const { service, platform, handler } = build()
      jest.spyOn(platform, 'applyGlobalEcoWrite').mockResolvedValue(true)
      handler.updateAllEco(false)

      await service.getCharacteristic(Characteristic.On).handleSetRequest(true)
      await service.getCharacteristic(Characteristic.On).handleSetRequest(false)
      handler.updateAllEco(true)

      jest.advanceTimersByTime(45_000)

      expect(service.getCharacteristic(Characteristic.On).value).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('a second Eco toggle reverts to the last Nest reading, not the first command', async () => {
    jest.useFakeTimers()
    try {
      const { service, platform, handler } = build()
      jest.spyOn(platform, 'applyGlobalEcoWrite').mockResolvedValue(true)
      handler.updateAllEco(false)

      await service.getCharacteristic(Characteristic.On).handleSetRequest(true)
      await service.getCharacteristic(Characteristic.On).handleSetRequest(false)

      jest.advanceTimersByTime(45_000)

      expect(service.getCharacteristic(Characteristic.On).value).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not fire the pending backstop after disposal', async () => {
    // The switch can be removed, or the platform stopped, while a write is still
    // unconfirmed. Without a disposal path the backstop fired up to 45s later
    // and refreshed a torn-down accessory.
    jest.useFakeTimers()
    try {
      const { service, platform, handler, log } = build()
      jest.spyOn(platform, 'applyGlobalEcoWrite').mockResolvedValue(true)

      await service.getCharacteristic(Characteristic.On).handleSetRequest(true)
      handler.dispose()

      jest.advanceTimersByTime(90_000)

      expect(log.warns.join('\n')).not.toMatch(/not confirmed in 45s, showing Nest state/)
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps an in-flight Eco confirmation when a later write is not sent', async () => {
    jest.useFakeTimers({ legacyFakeTimers: true })
    try {
      const { service, platform, handler, log } = build()
      const write = jest.spyOn(platform, 'applyGlobalEcoWrite')
      write.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      handler.updateAllEco(false)

      await service.getCharacteristic(Characteristic.On).handleSetRequest(true)
      await service.getCharacteristic(Characteristic.On).handleSetRequest(false)
      jest.runAllImmediates()
      expect(service.getCharacteristic(Characteristic.On).value).toBe(true)

      jest.advanceTimersByTime(45_000)
      expect(service.getCharacteristic(Characteristic.On).value).toBe(false)
      expect(log.warns.join('\n')).toMatch(/showing Nest state/)
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
    expect(log.warns.join('\n')).toMatch(/thermostat control is off/)
  })

  it('reports a failed write to HomeKit and reverts On', async () => {
    // A write that reached Nest and failed is not the same event as one the
    // plugin refused, and must not look like one: resolving would tell HomeKit
    // and any waiting automation the change was accepted.
    const { service, platform, handler } = build()
    handler.updateAllEco(false)
    jest.spyOn(platform, 'applyGlobalEcoWrite').mockRejectedValue(new Error('Nest 503'))

    // -70402 is HAPStatus.SERVICE_COMMUNICATION_FAILURE.
    await expect(service.getCharacteristic(Characteristic.On).handleSetRequest(true))
      .rejects.toBe(-70402)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(service.getCharacteristic(Characteristic.On).value).toBe(false)
  })
})
