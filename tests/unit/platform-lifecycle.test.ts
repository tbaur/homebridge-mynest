/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Platform behavior across restarts, partial inventories, and
 * startup failures, against a scripted transport.
 *
 * Each case here is a sequence that once left HomeKit wrong: a cached device
 * removed after one partial snapshot, a dropped Protect left showing a live
 * all-clear, a Protect stuck as a temperature sensor, and a house Eco switch
 * that flipped Off on every restart.
 */

import { Accessory, uuid } from '@homebridge/hap-nodejs'
import type { PlatformAccessory } from 'homebridge'
import type { NestTransportOptions, TransportStatus } from '../../src/api/transport'
import { decodeFrame } from '../../src/api/protobuf'
import { AuthenticationError } from '../../src/errors'
import { GLOBAL_ECO_DEVICE_ID, PLATFORM_NAME, UUID_PREFIX } from '../../src/settings'
import type { BucketMap } from '../../src/types/nest'
import { createHomebridgeLogging, FakeHomebridgeApi } from '../helpers/homebridge'
import { buildFrame, heatingThermostatTraits, protectTraits } from '../helpers/observe-fixtures'

let options: NestTransportOptions
let status: Partial<TransportStatus> = {}
let bootBuckets: BucketMap = {}

jest.mock('../../src/api/transport', () => {
  const { CircuitState } = jest.requireActual<typeof import('../../src/api/circuit-breaker')>(
    '../../src/api/circuit-breaker',
  )
  const closed = {
    state: CircuitState.CLOSED,
    failures: 0,
    successes: 0,
    lastFailureTime: null,
    isOpen: false,
    remainingResetTimeMs: null,
  }
  class NestTransport {
    constructor(transportOptions: NestTransportOptions) {
      options = transportOptions
    }

    get status(): TransportStatus {
      return {
        hasSession: true,
        observeFrames: 0,
        restCycles: 1,
        knownObjects: 0,
        observeState: 'connecting',
        restState: 'running',
        lastObserveFrameAgeSec: null,
        lastRestSuccessAgeSec: 0,
        isRestAlarmFeedAvailable: true,
        isDecodeDegraded: false,
        circuitBreaker: { rest: { ...closed }, observe: { ...closed } },
        ...status,
      }
    }

    start(): Promise<void> {
      const keys = Object.keys(bootBuckets.topaz ?? {}).map((id) => `topaz.${id}`)
      options.onBuckets(bootBuckets, keys)
      return Promise.resolve()
    }

    stop(): void {
      // Nothing to release.
    }

    updateThermostatSettings(): Promise<void> {
      return Promise.resolve()
    }

    updateEcoMode(): Promise<void> {
      return Promise.resolve()
    }
  }
  return { NestTransport }
})

import { MyNestPlatform } from '../../src/platform'

const transportModule = jest.requireMock<typeof import('../../src/api/transport')>('../../src/api/transport')

const COALESCE_MS = 250
const SETTLE_MS = 750

const thermostat = (id: string) => decodeFrame(buildFrame(heatingThermostatTraits(`DEVICE_${id}`))).traits

function cachedAccessory(id: string, kind: 'thermostat' | 'protect'): PlatformAccessory {
  const accessory = new Accessory(`Cached ${id}`, uuid.generate(`${UUID_PREFIX}${id}`)) as unknown as PlatformAccessory
  accessory.context = { deviceId: id, kind, displayName: `Cached ${id}` }
  return accessory
}

const deviceIds = (accessories: readonly PlatformAccessory[]): string[] => accessories
  .map((accessory) => (accessory.context as { deviceId: string }).deviceId)

describe('MyNestPlatform lifecycle', () => {
  let api: FakeHomebridgeApi
  let log: ReturnType<typeof createHomebridgeLogging>

  beforeEach(() => {
    jest.useFakeTimers()
    api = new FakeHomebridgeApi()
    log = createHomebridgeLogging()
    status = {}
    bootBuckets = {}
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  async function launch(
    cached: readonly PlatformAccessory[] = [],
    config: Record<string, unknown> = {},
  ): Promise<void> {
    const platform = new MyNestPlatform(
      log,
      { platform: PLATFORM_NAME, accessToken: 'b'.repeat(120), ...config },
      api.asApi(),
    )
    for (const accessory of cached) {
      platform.configureAccessory(accessory)
    }
    api.emit('didFinishLaunching')
    await Promise.resolve()
    await Promise.resolve()
    jest.advanceTimersByTime(COALESCE_MS)
  }

  /** Open an Observe session, deliver traits, and let the burst settle. */
  function observeBurst(traits: ReturnType<typeof thermostat>, frames: number): void {
    options.onObserveSessionStart?.()
    options.onTraits(traits)
    status = { ...status, observeFrames: frames }
    jest.advanceTimersByTime(COALESCE_MS)
    jest.advanceTimersByTime(SETTLE_MS)
    jest.advanceTimersByTime(COALESCE_MS)
  }

  describe('removing cached accessories', () => {
    it('keeps cached thermostats that a partial first burst omits', async () => {
      await launch([
        cachedAccessory('THERM01', 'thermostat'),
        cachedAccessory('THERM02', 'thermostat'),
        cachedAccessory('THERM03', 'thermostat'),
      ])

      observeBurst(thermostat('THERM01'), 1)
      options.onTraits([...thermostat('THERM02'), ...thermostat('THERM03')])
      jest.advanceTimersByTime(COALESCE_MS)

      expect(api.unregistered).toEqual([])
      expect(deviceIds(api.registered)).toEqual([])
    })

    it('keeps a cached REST-only Protect that the first app_launch omits', async () => {
      bootBuckets = { topaz: { PROTECT01: { serial_number: 'PROTECT01', smoke_status: 0, co_status: 0 } } }
      status = { knownObjects: 1 }
      await launch([
        cachedAccessory('PROTECT01', 'protect'),
        cachedAccessory('PROTECT02', 'protect'),
        cachedAccessory('THERM01', 'thermostat'),
      ])

      observeBurst(thermostat('THERM01'), 1)

      expect(api.unregistered).toEqual([])
    })

    it('removes a cached accessory that two settled snapshots both omit', async () => {
      const gone = cachedAccessory('GONE01', 'protect')
      await launch([gone])

      observeBurst(thermostat('THERM01'), 1)
      expect(api.unregistered).toEqual([])

      observeBurst(thermostat('THERM01'), 2)
      expect(api.unregistered).toEqual([gone])
      expect(log.infos.join('\n')).toContain('Removing Cached GONE01')
    })
  })

  describe('a Protect that Nest stops reporting', () => {
    it('marks smoke and CO inactive while HomeKit cannot remove it yet', async () => {
      bootBuckets = {
        topaz: { PROTECT01: { serial_number: 'PROTECT01', smoke_status: 0, co_status: 0, line_power_present: true } },
      }
      await launch()
      const accessory = api.registered[0]
      const smoke = accessory?.getService(api.hap.Service.SmokeSensor)
      const { StatusActive, StatusFault } = api.hap.Characteristic
      expect(smoke?.getCharacteristic(StatusActive).value).toBe(true)

      // REST dropped the topaz object. Observe never connected, so pruning is blocked.
      options.onBuckets({}, [])
      jest.advanceTimersByTime(COALESCE_MS)

      expect(api.unregistered).toEqual([])
      expect(smoke?.getCharacteristic(StatusActive).value).toBe(false)
      expect(smoke?.getCharacteristic(StatusFault).value).toBe(StatusFault.GENERAL_FAULT)
      await expect(smoke?.getCharacteristic(StatusActive).handleGetRequest()).resolves.toBe(false)
      expect(log.warns.join('\n')).toMatch(/no longer reported by Nest/)

      options.onBuckets(bootBuckets, ['topaz.PROTECT01'])
      jest.advanceTimersByTime(COALESCE_MS)

      expect(smoke?.getCharacteristic(StatusActive).value).toBe(true)
    })
  })

  describe('a device whose kind changes after it was published', () => {
    it('rebuilds a Protect first classified as a temperature sensor', async () => {
      await launch()
      const resourceId = 'DEVICE_PROTECT01'
      options.onTraits(decodeFrame(buildFrame([{
        resourceId,
        key: 'temperature',
        typeName: 'nest.trait.sensor.TemperatureTrait',
        value: { temperature: { value: { value: 21 } } },
      }])).traits)
      jest.advanceTimersByTime(COALESCE_MS)
      const accessory = api.registered[0]
      expect((accessory?.context as { kind: string }).kind).toBe('temperature_sensor')

      options.onTraits(decodeFrame(buildFrame(protectTraits(resourceId))).traits)
      jest.advanceTimersByTime(COALESCE_MS)

      expect(api.registered).toHaveLength(1)
      expect((accessory?.context as { kind: string }).kind).toBe('protect')
      expect(accessory?.getService(api.hap.Service.SmokeSensor)).toBeDefined()
      expect(accessory?.getService(api.hap.Service.CarbonMonoxideSensor)).toBeDefined()
    })

    it('classifies a REST topaz device as a Protect even when Observe says temperature sensor', async () => {
      bootBuckets = { topaz: { PROTECT01: { serial_number: 'PROTECT01', smoke_status: 0, co_status: 0 } } }
      await launch()
      options.onTraits(decodeFrame(buildFrame([{
        resourceId: 'DEVICE_PROTECT01',
        key: 'temperature',
        typeName: 'nest.trait.sensor.TemperatureTrait',
        value: { temperature: { value: { value: 21 } } },
      }])).traits)
      jest.advanceTimersByTime(COALESCE_MS)

      expect((api.registered[0]?.context as { kind: string }).kind).toBe('protect')
      expect(log.infos.join('\n')).not.toMatch(/Rebuilding its services/)
    })
  })

  describe('the house Eco switch', () => {
    function cachedEcoSwitch(isOn: boolean): PlatformAccessory {
      const accessory = new Accessory(
        'Nest Eco Mode',
        uuid.generate(`${UUID_PREFIX}${GLOBAL_ECO_DEVICE_ID}`),
      ) as unknown as PlatformAccessory
      accessory.context = {
        deviceId: GLOBAL_ECO_DEVICE_ID,
        kind: 'thermostat',
        displayName: 'Nest Eco Mode',
        synthetic: 'global_eco',
      }
      accessory.addService(api.hap.Service.Switch, 'Nest Eco Mode')
        .getCharacteristic(api.hap.Characteristic.On)
        .updateValue(isOn)
      return accessory
    }

    const ecoTraits = (id: string, ecoEnabled: 'ON' | 'OFF') => decodeFrame(buildFrame([
      ...heatingThermostatTraits(`DEVICE_${id}`),
      {
        resourceId: `DEVICE_${id}`,
        key: 'eco_mode_state',
        typeName: 'nest.trait.hvac.EcoModeStateTrait',
        value: { ecoEnabled },
      },
    ])).traits

    const isSwitchOn = (accessory: PlatformAccessory): unknown => accessory
      .getService(api.hap.Service.Switch)
      ?.getCharacteristic(api.hap.Characteristic.On).value

    it('keeps the cached position until Observe has settled', async () => {
      const ecoSwitch = cachedEcoSwitch(true)
      await launch([ecoSwitch], { exposeGlobalEcoSwitch: true })

      expect(isSwitchOn(ecoSwitch)).toBe(true)
    })

    it('keeps the cached position while a thermostat has not reported Eco', async () => {
      const ecoSwitch = cachedEcoSwitch(true)
      await launch([ecoSwitch], { exposeGlobalEcoSwitch: true })

      observeBurst([...ecoTraits('THERM01', 'ON'), ...thermostat('THERM02')], 1)

      expect(isSwitchOn(ecoSwitch)).toBe(true)
    })

    it('follows Nest once every thermostat has reported Eco', async () => {
      const ecoSwitch = cachedEcoSwitch(true)
      await launch([ecoSwitch], { exposeGlobalEcoSwitch: true })

      observeBurst([...ecoTraits('THERM01', 'ON'), ...ecoTraits('THERM02', 'OFF')], 1)

      expect(isSwitchOn(ecoSwitch)).toBe(false)
    })
  })

  describe('a cached Protect before Nest publishes it', () => {
    it('faults smoke, CO and occupancy from the Homebridge cache', async () => {
      const cached = cachedAccessory('PROTECT01', 'protect')
      const services = [
        cached.addService(api.hap.Service.SmokeSensor, 'Smoke'),
        cached.addService(api.hap.Service.CarbonMonoxideSensor, 'CO'),
        cached.addService(api.hap.Service.OccupancySensor, 'Occupancy'),
      ]
      const { StatusActive, StatusFault } = api.hap.Characteristic
      for (const service of services) {
        service.getCharacteristic(StatusActive).updateValue(true)
      }

      await launch([cached])

      for (const service of services) {
        expect(service.getCharacteristic(StatusActive).value).toBe(false)
        expect(service.getCharacteristic(StatusFault).value).toBe(StatusFault.GENERAL_FAULT)
      }
    })
  })

  describe('startup logging', () => {
    it('does not log "Platform ready" after a fatal error at startup', async () => {
      jest.spyOn(transportModule.NestTransport.prototype, 'start')
        .mockRejectedValueOnce(new AuthenticationError('rejected'))

      await launch()

      expect(log.errors.join('\n')).toMatch(/rejected/)
      expect(log.infos.join('\n')).not.toContain('Platform ready')
    })

    it('does not announce a background retry when shutdown aborts startup', async () => {
      let rejectStart: (error: Error) => void = () => undefined
      jest.spyOn(transportModule.NestTransport.prototype, 'start')
        .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
          rejectStart = reject
        }))

      await launch()
      api.emit('shutdown')
      rejectStart(new Error('This operation was aborted'))
      await Promise.resolve()
      await Promise.resolve()

      expect(log.warns.join('\n')).not.toMatch(/retrying in the background/)
    })
  })
})
