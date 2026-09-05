/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The thermostat accessory, against the real HAP implementation.
 */

import type { Characteristic as HapCharacteristic, PlatformAccessory } from 'homebridge'
import { ThermostatAccessory } from '../../../src/accessories/thermostat'
import type { DeviceOfKind } from '../../../src/types/device'
import type { ThermostatState } from '../../../src/types/device'
import { Characteristic, Service, createAccessory, createPlatformStub } from '../../helpers/hap'
import { createRecordingLogger } from '../../helpers/logger'

/**
 * Record HAP's own complaints about a characteristic into `sink`.
 *
 * Debug-level ones are dropped: `setProps` corrects an out-of-range cached
 * value on purpose and reports it at debug for exactly that reason, so it is
 * the warn and error entries that mean the plugin pushed something illegal.
 */
function captureWarnings(characteristic: HapCharacteristic, sink: string[]): void {
  characteristic.on('characteristic-warning', (type, message) => {
    if (String(type) !== 'debug-message') {
      sink.push(message)
    }
  })
}

/**
 * @param restoreCache Runs before the accessory is published, so a test can set
 *   up the Thermostat service the way Homebridge's cache hands one back after a
 *   restart — and watch what binding then does to it.
 */
function build(state: ThermostatState, restoreCache?: (accessory: PlatformAccessory) => void) {
  const platform = createPlatformStub()
  const accessory = createAccessory('Hallway Thermostat')
  const log = createRecordingLogger()

  restoreCache?.(accessory)

  const device: DeviceOfKind<'thermostat'> = {
    identity: {
      id: 'THERM01',
      kind: 'thermostat',
      name: 'Hallway Thermostat',
      sources: { observe: true, rest: false },
      model: 'Nest Thermostat E',
      serialNumber: 'THERM01',
      firmwareVersion: '6.3-5',
    },
    state,
  }

  const handler = new ThermostatAccessory(platform, accessory, device, log)
  const service = accessory.getService(Service.Thermostat as never)!

  const read = (type: typeof Characteristic.CurrentTemperature): unknown =>
    service.getCharacteristic(type as never).value

  return { handler, accessory, service, platform, log, read, device }
}

const heating: ThermostatState = {
  currentTemperatureC: 19.5,
  mode: 'heat',
  activity: 'heating',
  targetTemperatureC: 21,
  canHeat: true,
  canCool: false,
  displayUnit: 'C',
}

describe('ThermostatAccessory', () => {
  it('publishes the current and target temperatures', () => {
    const { read } = build(heating)

    expect(read(Characteristic.CurrentTemperature)).toBe(19.5)
    expect(read(Characteristic.TargetTemperature)).toBe(21)
  })

  // A reading is not a setpoint. Constraining CurrentTemperature to the
  // setpoint range clamped an unheated room up to the floor and rounded every
  // reading to the nearest half degree.
  // `toBeCloseTo` because HAP quantizes with
  // `step * Math.round((value - minValue) / step) + minValue`, which carries
  // floating-point noise well below a millidegree.
  it('reports a sub-zero reading without clamping it', () => {
    expect(build({ ...heating, currentTemperatureC: -3.4 }).read(Characteristic.CurrentTemperature))
      .toBeCloseTo(-3.4, 5)
  })

  it('keeps tenth-of-a-degree precision on the reading', () => {
    expect(build({ ...heating, currentTemperatureC: 19.7 }).read(Characteristic.CurrentTemperature))
      .toBeCloseTo(19.7, 5)
  })

  it('falls back to a mode the equipment actually supports', () => {
    // The fallback is used before Nest reports a mode, and HAP rejects any
    // value outside validValues. A cool-only unit publishes [OFF, COOL], so a
    // HEAT fallback would be refused and warn on every push.
    const { read, service } = build({
      currentTemperatureC: 22,
      canHeat: false,
      canCool: true,
    })

    const target = read(Characteristic.TargetHeatingCoolingState)
    const validValues = service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState as never)
      .props.validValues

    expect(target).toBe(Characteristic.TargetHeatingCoolingState.OFF)
    expect(validValues).toContain(target)
  })

  it('reports what the equipment is doing', () => {
    expect(build(heating).read(Characteristic.CurrentHeatingCoolingState))
      .toBe(Characteristic.CurrentHeatingCoolingState.HEAT)

    expect(build({ ...heating, activity: 'cooling' }).read(Characteristic.CurrentHeatingCoolingState))
      .toBe(Characteristic.CurrentHeatingCoolingState.COOL)

    expect(build({ ...heating, activity: 'idle' }).read(Characteristic.CurrentHeatingCoolingState))
      .toBe(Characteristic.CurrentHeatingCoolingState.OFF)
  })

  it('maps every Nest mode onto its HomeKit equivalent', () => {
    const cases = [
      ['off', Characteristic.TargetHeatingCoolingState.OFF],
      ['heat', Characteristic.TargetHeatingCoolingState.HEAT],
      ['cool', Characteristic.TargetHeatingCoolingState.COOL],
      ['range', Characteristic.TargetHeatingCoolingState.AUTO],
    ] as const

    for (const [mode, expected] of cases) {
      const { read } = build({ ...heating, mode, canHeat: true, canCool: true })
      expect(read(Characteristic.TargetHeatingCoolingState)).toBe(expected)
    }
  })

  it('offers only the modes the equipment supports', () => {
    // A heat-only thermostat offering "Cool" produces a control that cannot
    // work. Nest reports the capability by omitting it, so this is the visible
    // consequence of reading proto3 absence correctly.
    const { service } = build(heating)
    const valid = service.getCharacteristic(Characteristic.TargetHeatingCoolingState).props.validValues

    expect(valid).toEqual([
      Characteristic.TargetHeatingCoolingState.OFF,
      Characteristic.TargetHeatingCoolingState.HEAT,
    ])
  })

  it('offers auto only when the equipment can both heat and cool', () => {
    const { service } = build({ ...heating, canHeat: true, canCool: true })
    const valid = service.getCharacteristic(Characteristic.TargetHeatingCoolingState).props.validValues

    expect(valid).toContain(Characteristic.TargetHeatingCoolingState.AUTO)
  })

  it('publishes both bounds in range mode', () => {
    const { read } = build({
      ...heating,
      mode: 'range',
      canCool: true,
      targetTemperatureC: undefined,
      targetTemperatureLowC: 18,
      targetTemperatureHighC: 24,
    })

    expect(read(Characteristic.HeatingThresholdTemperature)).toBe(18)
    expect(read(Characteristic.CoolingThresholdTemperature)).toBe(24)
    // HomeKit still requires a single target; the midpoint is the meaningful
    // answer when Nest is regulating to a band.
    expect(read(Characteristic.TargetTemperature)).toBe(21)
  })

  it('never returns null from cooling-threshold onGet on a heat-only unit', async () => {
    // HomeKit polls onGet; null for Apple temperature characteristics spam the
    // log ("characteristic was supplied illegal value: null").
    const { service } = build(heating)
    const value = await service
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .handleGetRequest()

    expect(value).toEqual(expect.any(Number))
    expect(value).not.toBeNull()
  })

  it('never returns null from required thermostat onGets before Nest reports', async () => {
    // Null onGet answers for required Thermostat characteristics make Home show
    // "No Response" and hide room tiles even when Favorites / Home View are on.
    const { service } = build({})
    const required = [
      Characteristic.CurrentTemperature,
      Characteristic.CurrentHeatingCoolingState,
      Characteristic.TargetHeatingCoolingState,
      Characteristic.TargetTemperature,
      Characteristic.TemperatureDisplayUnits,
    ] as const

    for (const type of required) {
      const value = await service.getCharacteristic(type).handleGetRequest()
      expect(value).not.toBeNull()
      expect(value).not.toBeUndefined()
    }
  })

  it('constrains setpoints to the range Nest accepts', () => {
    const { service } = build(heating)
    const { minValue, maxValue, minStep } = service
      .getCharacteristic(Characteristic.TargetTemperature).props

    expect(minValue).toBe(9)
    // Nest's own 90 °F ceiling is 32.222 °C, which HAP quantizes onto the step
    // grid as 32.0 before range-checking it, so 32 contains every setpoint Nest
    // can report. Going higher would only let the Home app offer a setpoint
    // above Nest's limit.
    expect(maxValue).toBe(32)
    expect(minStep).toBe(0.5)
  })

  describe('publishing a setpoint', () => {
    // HAP validates every value against the characteristic's props, so a raw
    // Nest reading outside them is corrected and complained about on every
    // single push and poll. The write path has always clamped; the publish path
    // is what was missing, and matching HAP's own arithmetic here is also what
    // keeps `onGet`, plugin state, and HomeKit's cache on one number.

    /** Watch a setpoint characteristic from before the accessory publishes. */
    const watch = (
      type: typeof Characteristic.TargetTemperature,
      warnings: string[],
    ) => (accessory: PlatformAccessory) => {
      captureWarnings(
        accessory.addService(Service.Thermostat as never).getCharacteristic(type as never),
        warnings,
      )
    }

    it('publishes Nest\'s 90 °F cooling ceiling within the props it declared', () => {
      // 90 °F is 32.222 °C, which HAP quantizes to 32.0 before range-checking,
      // so it lands inside the declared ceiling without any headroom above 32.
      const warnings: string[] = []
      const { service } = build({
        currentTemperatureC: 30,
        mode: 'cool',
        activity: 'cooling',
        targetTemperatureC: 32.222,
        canHeat: false,
        canCool: true,
        displayUnit: 'F',
      }, watch(Characteristic.TargetTemperature, warnings))

      const characteristic = service.getCharacteristic(Characteristic.TargetTemperature)
      expect(characteristic.value).toBeLessThanOrEqual(characteristic.props.maxValue!)
      expect(characteristic.value).toBeGreaterThanOrEqual(32)
      expect(warnings).toEqual([])
    })

    it('quantizes a Fahrenheit thermostat\'s setpoint onto the half-degree grid', () => {
      // Nest stores 72 °F as 22.222 °C. Publishing that leaves the plugin
      // believing it pushed 22.222 while HomeKit holds 22.
      const { read } = build({ ...heating, targetTemperatureC: 22.222 })

      expect(read(Characteristic.TargetTemperature)).toBe(22)
    })

    it('clamps a setpoint below Nest\'s floor without HAP objecting', () => {
      const warnings: string[] = []
      const { read } = build(
        { ...heating, targetTemperatureC: 4 },
        watch(Characteristic.TargetTemperature, warnings),
      )

      expect(read(Characteristic.TargetTemperature)).toBe(9)
      expect(warnings).toEqual([])
    })

    it('answers a HomeKit poll for an out-of-range setpoint without objecting', async () => {
      // HomeKit polls onGet, and HAP validates the answer the same way it
      // validates a push — so an unclamped reader complains on every poll, not
      // just once.
      const warnings: string[] = []
      const { service } = build(
        { ...heating, targetTemperatureC: 4 },
        watch(Characteristic.TargetTemperature, warnings),
      )

      await expect(
        service.getCharacteristic(Characteristic.TargetTemperature).handleGetRequest(),
      ).resolves.toBe(9)
      expect(warnings).toEqual([])
    })

    it('publishes both range bounds on the grid', () => {
      const { read } = build({
        ...heating,
        mode: 'range',
        canCool: true,
        targetTemperatureC: undefined,
        targetTemperatureLowC: 18.888,
        targetTemperatureHighC: 32.222,
      })

      expect(read(Characteristic.HeatingThresholdTemperature)).toBe(19)
      expect(read(Characteristic.CoolingThresholdTemperature)).toBe(32)
    })
  })

  describe('a setpoint restored from the Homebridge cache', () => {
    // `Characteristic.deserialize` assigns `value` directly, with no
    // validation, so a restored accessory really can hold a setpoint outside
    // every prop range now in force. Seeding through `updateValue` would
    // validate against HAP's defaults and correct the thing under test.
    //
    // State is empty in both cases so the reader has no Nest value and falls
    // back to what binding left on the characteristic.
    const restore = (
      type: typeof Characteristic.TargetTemperature,
      value: number,
      warnings: string[],
    ) => (accessory: PlatformAccessory) => {
      const characteristic = accessory
        .addService(Service.Thermostat as never)
        .getCharacteristic(type as never)
      characteristic.value = value
      captureWarnings(characteristic, warnings)
    }

    it('is brought inside the range when it sits above the ceiling', () => {
      const warnings: string[] = []
      const { service } = build(
        {},
        restore(Characteristic.CoolingThresholdTemperature, 34, warnings),
      )

      expect(service.getCharacteristic(Characteristic.CoolingThresholdTemperature).value)
        .toBe(32)
      expect(warnings).toEqual([])
    })

    it('is brought inside the range when it sits below the floor', () => {
      // Heating Threshold is the one that actually arrives out of range: HAP
      // defaults it to 0 °C, below Nest's floor.
      const warnings: string[] = []
      const { service } = build(
        {},
        restore(Characteristic.HeatingThresholdTemperature, -40, warnings),
      )

      expect(service.getCharacteristic(Characteristic.HeatingThresholdTemperature).value)
        .toBe(9)
      expect(warnings).toEqual([])
    })
  })

  it('reports the unit the device itself displays', () => {
    expect(build({ ...heating, displayUnit: 'F' }).read(Characteristic.TemperatureDisplayUnits))
      .toBe(Characteristic.TemperatureDisplayUnits.FAHRENHEIT)
    expect(build(heating).read(Characteristic.TemperatureDisplayUnits))
      .toBe(Characteristic.TemperatureDisplayUnits.CELSIUS)
  })

  it('does not offer to change the display unit, which it cannot do', () => {
    const { service } = build(heating)
    const perms = service.getCharacteristic(Characteristic.TemperatureDisplayUnits).props.perms

    expect(perms).not.toContain('pw')
  })

  it('publishes humidity only when the thermostat measures it', () => {
    const withHumidity = build({ ...heating, currentHumidity: 44 })
    expect(withHumidity.read(Characteristic.CurrentRelativeHumidity)).toBe(44)
  })

  it('binds humidity when it arrives after the first publish', () => {
    const { handler, read, device } = build(heating)

    handler.update({ ...device, state: { ...heating, currentHumidity: 41 } })

    expect(read(Characteristic.CurrentRelativeHumidity)).toBe(41)
  })

  it('narrows target modes when equipment capabilities arrive later', () => {
    const { handler, service, device } = build({
      ...heating,
      canHeat: undefined,
      canCool: undefined,
    })

    expect(service.getCharacteristic(Characteristic.TargetHeatingCoolingState).props.validValues)
      .toContain(Characteristic.TargetHeatingCoolingState.AUTO)

    handler.update({ ...device, state: { ...heating, canHeat: true, canCool: false } })

    expect(service.getCharacteristic(Characteristic.TargetHeatingCoolingState).props.validValues)
      .toEqual([
        Characteristic.TargetHeatingCoolingState.OFF,
        Characteristic.TargetHeatingCoolingState.HEAT,
      ])
  })

  it('pushes new readings into HomeKit as they arrive', () => {
    const { handler, read, device } = build(heating)

    handler.update({
      ...device,
      state: { ...heating, currentTemperatureC: 22.5, targetTemperatureC: 23, activity: 'idle' },
    })

    expect(read(Characteristic.CurrentTemperature)).toBe(22.5)
    expect(read(Characteristic.TargetTemperature)).toBe(23)
    expect(read(Characteristic.CurrentHeatingCoolingState))
      .toBe(Characteristic.CurrentHeatingCoolingState.OFF)
  })

  it('keeps the last reading when Nest stops reporting one', () => {
    const { handler, read, device } = build(heating)

    handler.update({ ...device, state: { ...heating, currentTemperatureC: undefined } })

    expect(read(Characteristic.CurrentTemperature)).toBe(19.5)
  })

  it('keeps write permission on target characteristics (Home needs them for tiles)', () => {
    // Stripping PAIRED_WRITE made the Home app show "No Response" and hide
    // room tiles even when Favorites / Home View were on.
    const { service } = build(heating)

    expect(service.getCharacteristic(Characteristic.TargetTemperature).props.perms)
      .toContain('pw')
    expect(service.getCharacteristic(Characteristic.TargetHeatingCoolingState).props.perms)
      .toContain('pw')
  })

  it('publishes an Eco Mode switch reflecting Nest Eco state', () => {
    const { accessory, read } = build({ ...heating, isEcoActive: true })
    const eco = accessory.getService(Service.Switch as never)
    expect(eco).toBeDefined()
    expect(eco!.getCharacteristic(Characteristic.On).value).toBe(true)
    expect(read(Characteristic.CurrentTemperature)).toBe(19.5)
  })

  it('routes Eco switch writes through the platform', async () => {
    const { accessory, platform, log } = build(heating)
    const spy = jest.spyOn(platform, 'applyEcoWrite').mockResolvedValue(true)
    const eco = accessory.getService(Service.Switch as never)!

    await eco.getCharacteristic(Characteristic.On).handleSetRequest(true)

    expect(spy).toHaveBeenCalledWith('THERM01', true)
    expect(log.infos.join('\n')).toMatch(/Hallway Thermostat: Updating to Eco/)
  })

  it('reports a failed Eco write to HomeKit', async () => {
    // Same distinction the setpoint path draws: a refusal resolves, a genuine
    // failure is reported. -70402 is HAPStatus.SERVICE_COMMUNICATION_FAILURE.
    const { accessory, platform, log } = build(heating)
    jest.spyOn(platform, 'applyEcoWrite').mockRejectedValue(new Error('Nest 503'))
    const eco = accessory.getService(Service.Switch as never)!

    await expect(eco.getCharacteristic(Characteristic.On).handleSetRequest(true))
      .rejects.toBe(-70402)

    expect(log.warns.join('\n')).toMatch(/Hallway Thermostat: Eco update failed/)
  })

  it('resolves a refused Eco write rather than reporting a failure', async () => {
    const { accessory, platform, log } = build(heating)
    jest.spyOn(platform, 'applyEcoWrite').mockResolvedValue(false)
    const eco = accessory.getService(Service.Switch as never)!

    await expect(eco.getCharacteristic(Characteristic.On).handleSetRequest(true))
      .resolves.not.toThrow()

    expect(log.warns.join('\n')).toMatch(/enable Allow thermostat control/)
  })

  it('routes target temperature writes through the platform', async () => {
    const { service, platform, log } = build(heating)
    const spy = jest.spyOn(platform, 'applyThermostatWrite').mockResolvedValue({
      resourceId: 'DEVICE_THERM01',
      mode: 'heat',
      targetTemperatureHeatC: 22.5,
      targetTemperatureCoolC: 26,
      standbyMode: 'heat',
      clearEco: false,
    })

    await service.getCharacteristic(Characteristic.TargetTemperature)
      .handleSetRequest(22.5)

    expect(spy).toHaveBeenCalledWith(
      'THERM01',
      expect.objectContaining({ targetTemperatureC: 21 }),
      { targetTemperatureC: 22.5 },
    )
    expect(log.infos.join('\n')).toMatch(/Hallway Thermostat: Updating Heat to 22\.5°C/)
  })

  it('routes a HomeKit mode change through the platform', async () => {
    const { service, platform } = build({ ...heating, canHeat: true, canCool: true })
    const spy = jest.spyOn(platform, 'applyThermostatWrite').mockResolvedValue({
      resourceId: 'DEVICE_THERM01',
      mode: 'cool',
      targetTemperatureHeatC: 21,
      targetTemperatureCoolC: 26,
      standbyMode: 'cool',
      clearEco: false,
    })

    await service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .handleSetRequest(Characteristic.TargetHeatingCoolingState.COOL)

    expect(spy).toHaveBeenCalledWith(
      'THERM01',
      expect.anything(),
      { mode: 'cool' },
    )
  })

  it('routes both range threshold writes through the platform', async () => {
    const { service, platform } = build({ ...heating, mode: 'range', canHeat: true, canCool: true })
    const spy = jest.spyOn(platform, 'applyThermostatWrite').mockResolvedValue({
      resourceId: 'DEVICE_THERM01',
      mode: 'range',
      targetTemperatureHeatC: 19,
      targetTemperatureCoolC: 25,
      standbyMode: 'range',
      clearEco: false,
    })

    await service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .handleSetRequest(19)
    expect(spy).toHaveBeenCalledWith('THERM01', expect.anything(), { targetTemperatureLowC: 19 })

    await service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .handleSetRequest(25)
    expect(spy).toHaveBeenCalledWith('THERM01', expect.anything(), { targetTemperatureHighC: 25 })
  })

  it('tells HomeKit a failed Nest write failed', async () => {
    // Resolving would report the HVAC as changed when it was not, leaving the
    // user with a slider that springs back and no reason given.
    const { service, platform, read, log } = build(heating)
    jest.spyOn(platform, 'applyThermostatWrite').mockRejectedValue(new Error('Nest 503'))

    await expect(
      service.getCharacteristic(Characteristic.TargetTemperature).handleSetRequest(24),
    ).rejects.toBe(-70402)

    expect(log.warns.join('\n')).toMatch(/Hallway Thermostat: thermostat update failed/)
    // Nest's last known values still go back, so the error status cannot stick:
    // updateValue clears it, as does the next onGet.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(read(Characteristic.TargetTemperature)).toBe(21)
    expect(service.getCharacteristic(Characteristic.TargetTemperature).statusCode).toBe(0)
  })

  it('does not surface the Nest error text to HomeKit', async () => {
    // A rethrown Nest error takes HAP's unhandled-error path, which prints the
    // stack. The message is already logged above, redacted.
    const { service, platform } = build(heating)
    jest.spyOn(platform, 'applyThermostatWrite')
      .mockRejectedValue(new Error('Nest 503 for token abc123'))

    const rejection = await service.getCharacteristic(Characteristic.TargetTemperature)
      .handleSetRequest(24)
      .then(() => undefined, (error: unknown) => error)

    expect(String(rejection)).not.toContain('abc123')
  })

  it('reverts HomeKit when thermostat control is disabled', async () => {
    // Deliberately *not* an error: nothing malfunctioned, so onSet resolves and
    // only the slider moves back. Reporting a failure here would fault a
    // read-only install on every touch.
    const { service, platform, read, log } = build(heating)
    jest.spyOn(platform, 'applyThermostatWrite').mockResolvedValue(null)

    await expect(
      service.getCharacteristic(Characteristic.TargetTemperature).handleSetRequest(24),
    ).resolves.toBeUndefined()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(read(Characteristic.TargetTemperature)).toBe(21)
    expect(log.warns.join('\n')).toMatch(/Hallway Thermostat: ignoring HomeKit change/)
  })

  it('records the device details HomeKit shows', () => {
    const { accessory } = build(heating)
    const information = accessory.getService(Service.AccessoryInformation as never)!

    expect(information.getCharacteristic(Characteristic.Manufacturer).value).toBe('Nest')
    expect(information.getCharacteristic(Characteristic.Model).value).toBe('Nest Thermostat E')
    expect(information.getCharacteristic(Characteristic.SerialNumber).value).toBe('THERM01')
    expect(information.getCharacteristic(Characteristic.FirmwareRevision).value).toBe('6.3-5')
  })

  it('propagates a Nest rename into AccessoryInformation', () => {
    const { handler, accessory, device } = build(heating)

    handler.update({
      ...device,
      identity: { ...device.identity, name: 'Living Room', firmwareVersion: '6.4-1' },
    })

    const information = accessory.getService(Service.AccessoryInformation as never)!
    expect(information.getCharacteristic(Characteristic.Name).value).toBe('Living Room')
    expect(information.getCharacteristic(Characteristic.FirmwareRevision).value).toBe('6.4-1')
  })

  it('announces the first reading, then logs changes but not repeats', () => {
    const { handler, log, device } = build(heating)

    // The first summary is info: it is the only default-visible confirmation
    // that a newly published device is actually reporting anything.
    handler.update({ ...device, state: heating })
    expect(log.infos.join('\n')).toContain('19.5')

    log.infos.length = 0
    handler.update({ ...device, state: heating })
    expect(log.infos).toEqual([])

    handler.update({ ...device, state: { ...heating, currentTemperatureC: 25 } })
    expect(log.infos.join('\n')).toContain('25.0')
  })

  it('says so plainly when nothing has been reported yet', () => {
    const { handler, log, device } = build({})

    handler.update({ ...device, state: {} })

    expect(log.infos.join('\n')).toContain('No readings yet')
  })
})
