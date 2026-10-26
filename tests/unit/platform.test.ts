/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Platform lifecycle: restore, publish, merge sync, stale removal.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Sqlite from 'node:sqlite'

import { Accessory, Characteristic, Service, uuid } from '@homebridge/hap-nodejs'

const Categories = (jest.requireActual('@homebridge/hap-nodejs') as {
  Categories: Record<string, number>
}).Categories
import type { PlatformAccessory } from 'homebridge'
import { CircuitState } from '../../src/api/circuit-breaker'
import type { NestTransportOptions, TransportStatus } from '../../src/api/transport'
import type { TraitUpdate } from '../../src/api/protobuf'
import type { BucketMap } from '../../src/types/nest'
import { AuthenticationError, NetworkError, SessionShapeError } from '../../src/errors'
import {
  OBSERVE_SNAPSHOT_ABANDON_MS,
  PLATFORM_NAME,
  UUID_PREFIX,
} from '../../src/settings'
import { createHomebridgeLogging, FakeHomebridgeApi } from '../helpers/homebridge'
import {
  buildFrame,
  heatingThermostatTraits,
  protectTraits,
} from '../helpers/observe-fixtures'
import { decodeFrame } from '../../src/api/protobuf'
import { MAX_TRACKED_RESOURCES } from '../../src/state/observe-state'

interface TransportHarness {
  options: NestTransportOptions
  status: TransportStatus
  start: jest.Mock
  stop: jest.Mock
  updateThermostatSettings: jest.Mock
  updateEcoMode: jest.Mock
}

let harness: TransportHarness
/** Errors the mocked `transport.start()` should throw, in order. */
const pendingStartFailures: Error[] = []

const DEFAULT_STATUS: TransportStatus = {
  hasSession: true,
  observeFrames: 0,
  restCycles: 0,
  knownObjects: 0,
  observeState: 'connecting',
  restState: 'running',
  lastObserveFrameAgeSec: null,
  lastRestSuccessAgeSec: 0,
  isRestAlarmFeedAvailable: true,
  isDecodeDegraded: false,
  circuitBreaker: {
    rest: {
      state: CircuitState.CLOSED,
      failures: 0,
      successes: 0,
      lastFailureTime: null,
      isOpen: false,
      remainingResetTimeMs: null,
    },
    observe: {
      state: CircuitState.CLOSED,
      failures: 0,
      successes: 0,
      lastFailureTime: null,
      isOpen: false,
      remainingResetTimeMs: null,
    },
  },
}

function setTransportStatus(partial: Partial<TransportStatus>): void {
  harness.status = { ...DEFAULT_STATUS, ...partial }
}


jest.mock('../../src/api/transport', () => {
  // Require inside the factory: jest.mock is hoisted above ESM imports.
  const { CircuitState: State } = require('../../src/api/circuit-breaker') as typeof import('../../src/api/circuit-breaker')
  const closedBreaker = {
    state: State.CLOSED,
    failures: 0,
    successes: 0,
    lastFailureTime: null,
    isOpen: false,
    remainingResetTimeMs: null,
  }

  class NestTransport {
    constructor(options: NestTransportOptions) {
      harness = {
        options,
        status: {
          hasSession: true,
          observeFrames: 0,
          restCycles: 0,
          knownObjects: 0,
          observeState: 'connecting',
          restState: 'running',
          lastObserveFrameAgeSec: null,
          lastRestSuccessAgeSec: 0,
          isRestAlarmFeedAvailable: true,
  isDecodeDegraded: false,
          circuitBreaker: {
            rest: { ...closedBreaker },
            observe: { ...closedBreaker },
          },
        },
        start: jest.fn(async () => {
          // Lets a test make the first boot attempt fail, which is otherwise
          // impossible to arrange: the transport is constructed and started in
          // the same tick inside the platform.
          const failure = pendingStartFailures.shift()
          if (failure) {
            throw failure
          }
          // REST-first boot: buckets arrive before Observe frames.
          options.onBuckets(restBuckets)
        }),
        stop: jest.fn(),
        updateThermostatSettings: jest.fn(async () => undefined),
        updateEcoMode: jest.fn(async () => undefined),
      }
      Object.defineProperty(this, 'status', {
        get: () => harness.status,
      })
    }

    start(): Promise<void> {
      return harness.start()
    }

    stop(): void {
      harness.stop()
    }

    updateThermostatSettings(write: unknown): Promise<void> {
      return harness.updateThermostatSettings(write)
    }

    updateEcoMode(resourceId: string, ecoOn: boolean): Promise<void> {
      return harness.updateEcoMode(resourceId, ecoOn)
    }
  }

  return { NestTransport }
})

import { MyNestPlatform } from '../../src/platform'
import { PAGERDUTY_STARTUP_LOG } from '../../src/nest-signals'

const sqlite = typeof process.getBuiltinModule === 'function'
  ? process.getBuiltinModule('node:sqlite') as typeof Sqlite | undefined
  : undefined
const describeWithSqlite = sqlite ? describe : describe.skip

const THERMOSTAT_ID = 'THERM0001'
const PROTECT_ID = 'PROTECT01'
const OBSERVE_ONLY_PROTECT_ID = 'PROTECT99'

const restBuckets: BucketMap = {
  topaz: {
    [PROTECT_ID]: {
      serial_number: PROTECT_ID,
      model: 'Topaz-2.7',
      smoke_status: 0,
      co_status: 0,
      line_power_present: true,
      auto_away: false,
      description: 'Zone One Protect',
    },
  },
}

function thermostatTraits(): readonly TraitUpdate[] {
  return thermostatTraitsFor(THERMOSTAT_ID)
}

function thermostatTraitsFor(id: string): readonly TraitUpdate[] {
  return decodeFrame(buildFrame(heatingThermostatTraits(`DEVICE_${id}`))).traits
}

function protectTraitsFor(id: string): readonly TraitUpdate[] {
  return decodeFrame(buildFrame(protectTraits(`DEVICE_${id}`))).traits
}

describe('MyNestPlatform', () => {
  let api: FakeHomebridgeApi
  let log: ReturnType<typeof createHomebridgeLogging>

  beforeEach(() => {
    jest.useFakeTimers()
    api = new FakeHomebridgeApi()
    log = createHomebridgeLogging()
    pendingStartFailures.length = 0
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  async function launch(overrides: Record<string, unknown> = {}): Promise<MyNestPlatform> {
    const platform = new MyNestPlatform(
      log,
      {
        platform: PLATFORM_NAME,
        accessToken: 'b'.repeat(120),
        ...overrides,
      },
      api.asApi(),
    )
    api.emit('didFinishLaunching')
    await Promise.resolve()
    await Promise.resolve()
    return platform
  }

  function flushSync(): void {
    jest.advanceTimersByTime(250)
  }

  it('refuses to start without a usable access token', async () => {
    new MyNestPlatform(log, { platform: PLATFORM_NAME }, api.asApi())
    api.emit('didFinishLaunching')
    await Promise.resolve()

    expect(log.errors.join('\n')).toMatch(/Access Token is required/)
    expect(api.registered).toHaveLength(0)
  })

  it('retries a transient startup failure instead of blaming the token', async () => {
    // A Raspberry Pi that boots before its network is up rejects here with a
    // NetworkError. Treating that as fatal disabled the plugin for the life of
    // the process and told the user to paste a fresh token — and because
    // `didFinishLaunching` fires once, nothing ever tried again.
    pendingStartFailures.push(new NetworkError('Could not reach https://home.nest.com/session'))

    await launch()

    expect(log.warns.join('\n')).toMatch(/Nest unreachable at startup/)
    expect(log.errors.join('\n')).not.toMatch(/Get a new token/)

    // Backoff, then a successful second attempt.
    await jest.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()

    expect(log.infos.join('\n')).toContain('Connected to Nest')
  })

  it('still treats a rejected token at startup as fatal', async () => {
    pendingStartFailures.push(new AuthenticationError())

    await launch()

    expect(log.errors.join('\n')).toMatch(/Get a new token/)
    expect(log.warns.join('\n')).not.toMatch(/retrying in the background/)
  })

  it('logs that thermostat control is enabled when the flag is on', async () => {
    await launch({ allowThermostatControl: true })
    expect(log.infos.join('\n')).toMatch(/Thermostat control enabled/)
  })

  it('does not call Nest when thermostat control is off', async () => {
    const platform = await launch({ allowThermostatControl: false })
    const write = await platform.applyThermostatWrite(
      THERMOSTAT_ID,
      { mode: 'heat', targetTemperatureC: 21, targetTemperatureLowC: 21, targetTemperatureHighC: 26 },
      { targetTemperatureC: 22 },
    )

    expect(write).toBeNull()
    expect(harness.updateThermostatSettings).not.toHaveBeenCalled()
  })

  it('sends BatchUpdateState when thermostat control is on', async () => {
    const platform = await launch({ allowThermostatControl: true })
    const write = await platform.applyThermostatWrite(
      THERMOSTAT_ID,
      { mode: 'heat', targetTemperatureC: 21, targetTemperatureLowC: 21, targetTemperatureHighC: 26 },
      { targetTemperatureC: 22 },
    )

    expect(write).toEqual(expect.objectContaining({
      resourceId: `DEVICE_${THERMOSTAT_ID}`,
      mode: 'heat',
      targetTemperatureHeatC: 22,
    }))
    expect(harness.updateThermostatSettings).toHaveBeenCalledWith(write)
  })

  it('publishes a global Eco switch when enabled', async () => {
    await launch({ exposeGlobalEcoSwitch: true })
    harness.options.onTraits(thermostatTraits())
    setTransportStatus({
      hasSession: true,
      observeFrames: 1,
      restCycles: 1,
      knownObjects: 1,
    })
    flushSync()

    expect(api.registered.some((accessory) => accessory.displayName === 'Nest Eco Mode')).toBe(true)
    expect(log.infos.join('\n')).toMatch(/Nest Eco Mode/)
  })

  it('writes Eco to every thermostat from the global switch', async () => {
    const platform = await launch({
      allowThermostatControl: true,
      exposeGlobalEcoSwitch: true,
    })
    harness.options.onTraits(thermostatTraits())
    setTransportStatus({
      hasSession: true,
      observeFrames: 1,
      restCycles: 1,
      knownObjects: 1,
    })
    flushSync()

    const sent = await platform.applyGlobalEcoWrite(true)
    expect(sent).toBe(true)
    expect(harness.updateEcoMode).toHaveBeenCalledWith(`DEVICE_${THERMOSTAT_ID}`, true)
  })

  it('writes Eco to one thermostat when control is enabled', async () => {
    const platform = await launch({ allowThermostatControl: true })

    await expect(platform.applyEcoWrite(THERMOSTAT_ID, true)).resolves.toBe(true)
    expect(harness.updateEcoMode).toHaveBeenCalledWith(`DEVICE_${THERMOSTAT_ID}`, true)
  })

  it('does not write Eco when control is disabled', async () => {
    const platform = await launch({ allowThermostatControl: false })

    await expect(platform.applyEcoWrite(THERMOSTAT_ID, true)).resolves.toBe(false)
    expect(harness.updateEcoMode).not.toHaveBeenCalled()
  })

  it('survives a cached accessory restored without a context', async () => {
    // Homebridge assigns `context` verbatim from the persisted cache, so an
    // accessory stored without one restores as undefined. Dereferencing it
    // threw, and the throw surfaced as "Eco update failed" on every press
    // while no thermostat was ever written to.
    const platform = await launch({
      allowThermostatControl: true,
      exposeGlobalEcoSwitch: true,
    })
    const orphan = new Accessory(
      'Orphan',
      uuid.generate(`${UUID_PREFIX}ORPHAN`),
    ) as unknown as PlatformAccessory
    ;(orphan as { context?: unknown }).context = undefined
    platform.configureAccessory(orphan)

    harness.options.onTraits(thermostatTraits())
    setTransportStatus({ observeFrames: 1, restCycles: 1, knownObjects: 1 })
    flushSync()

    await expect(platform.applyGlobalEcoWrite(true)).resolves.toBe(true)
    expect(harness.updateEcoMode).toHaveBeenCalledWith(`DEVICE_${THERMOSTAT_ID}`, true)
  })

  it('keeps reminding the operator after a fatal authentication failure', async () => {
    // #stop() tears down the transport heartbeat and the diagnostics timer, so
    // without a standing reminder the plugin goes silent forever while HomeKit
    // keeps serving frozen readings.
    await launch()
    flushSync()

    harness.options.onFatal(new Error('Nest rejected the token.'))
    const initialErrors = log.errors.length

    jest.advanceTimersByTime(60 * 60_000)

    expect(log.errors.length).toBeGreaterThan(initialErrors)
    expect(log.errors.join('\n')).toMatch(/Still stopped/)
  })

  it('refuses a global Eco write when there are no thermostats', async () => {
    const platform = await launch({
      allowThermostatControl: true,
      exposeGlobalEcoSwitch: true,
    })
    flushSync()

    const sent = await platform.applyGlobalEcoWrite(true)
    expect(sent).toBe(false)
    expect(harness.updateEcoMode).not.toHaveBeenCalled()
    expect(log.warns.join('\n')).toMatch(/no thermostats/)
  })

  it('refuses a global Eco write when any thermostat fails', async () => {
    const platform = await launch({
      allowThermostatControl: true,
      exposeGlobalEcoSwitch: true,
    })
    harness.options.onTraits([
      ...thermostatTraits(),
      ...thermostatTraitsFor('THERM0002'),
    ])
    setTransportStatus({
      hasSession: true,
      observeFrames: 1,
      restCycles: 1,
      knownObjects: 1,
    })
    flushSync()

    harness.updateEcoMode
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Nest 503'))

    await expect(platform.applyGlobalEcoWrite(true)).rejects.toThrow(/1 of 2/)
    const warns = log.warns.join('\n')
    expect(warns).toMatch(/THERM0002/)
    expect(warns).not.toMatch(/HomeKit left unchanged/)
  })

  it('keeps Protect smoke/CO when the REST alarm feed becomes unavailable', async () => {
    await launch()
    flushSync()

    const protect = api.registered.find(
      (accessory) => (accessory.context as { deviceId?: string }).deviceId === PROTECT_ID,
    )
    expect(protect).toBeDefined()
    expect(protect!.getService(api.hap.Service.SmokeSensor)).toBeDefined()

    setTransportStatus({ isRestAlarmFeedAvailable: false })
    harness.options.onRestAlarmFeedChange?.(false)
    flushSync()

    // Services stay so rooms/automations are not torn down on a Nest blip.
    expect(protect!.getService(api.hap.Service.SmokeSensor)).toBeDefined()
    expect(protect!.getService(api.hap.Service.CarbonMonoxideSensor)).toBeDefined()
  })

  it('still prunes a ghost accessory after a slow Observe connection', async () => {
    // HomeKit pruning is gated on a *settled* snapshot. Arming the 750 ms quiet
    // window at session start meant a connection that took longer than that to
    // deliver its first trait finalized an empty snapshot, nulled the collector,
    // stopped re-arming, and left `#hasSettledObserveSnapshot` false — so the
    // ghost below would never be unregistered. Pruning is the only observable
    // consequence, so it is what this asserts.
    const ghostUuid = uuid.generate(`${UUID_PREFIX}GHOST01`)
    const ghost = new Accessory('Ghost Protect', ghostUuid) as unknown as PlatformAccessory
    ghost.context = { deviceId: 'GHOST01', kind: 'protect', displayName: 'Ghost Protect' }

    const platform = new MyNestPlatform(
      log,
      { platform: PLATFORM_NAME, accessToken: 'b'.repeat(120) },
      api.asApi(),
    )
    platform.configureAccessory(ghost)
    api.emit('didFinishLaunching')
    await Promise.resolve()
    await Promise.resolve()
    flushSync()

    // Two consecutive settled snapshots that omit the ghost confirm removal.
    for (const frames of [1, 2]) {
      harness.options.onObserveSessionStart?.()
      // Slower than the settle window, well inside the abandon window: the
      // collector must still be open when the first trait lands.
      jest.advanceTimersByTime(5_000)
      harness.options.onTraits(thermostatTraits())
      setTransportStatus({ observeFrames: frames, restCycles: 1, knownObjects: 1 })
      await settleObserveSnapshot()
    }

    expect(api.unregistered).toContain(ghost)
  })

  it('warns when Observe floods the plugin with more resources than it models', async () => {
    await launch()
    flushSync()

    harness.options.onTraits(
      Array.from({ length: MAX_TRACKED_RESOURCES + 10 }, (_, index) => ({
        resourceId: `DEVICE_FLOOD${index}`,
        key: 'label',
      })),
    )
    flushSync()

    expect(log.warns.join('\n')).toMatch(/tracking \d+ resources/)
  })

  it('stops collecting a snapshot only after the abandon deadline', async () => {
    // A session that connects but never names a device must not leave the
    // collector open forever, or pruning stays blocked for that session.
    await launch({ debug: true })
    flushSync()

    harness.options.onObserveSessionStart?.()
    jest.advanceTimersByTime(OBSERVE_SNAPSHOT_ABANDON_MS + 1_000)
    flushSync()

    expect(log.debugs.join('\n')).toMatch(/produced no devices before the snapshot deadline/)
  })

  it('keeps traits that arrived before a device could be classified', async () => {
    // Nest streams a device's traits across several frames, and
    // `classifyResource` needs an HVAC/Protect/temperature type before the
    // device can enter the inventory. Pruning Observe state on inventory
    // absence discarded the identity and label from the earlier frames, so the
    // thermostat was later republished as "Thermostat 0001" with no model.
    await launch()
    flushSync()

    const fixtures = heatingThermostatTraits(`DEVICE_${THERMOSTAT_ID}`)
    const isIdentity = (key: string): boolean => key === 'device_identity' || key === 'label'

    harness.options.onTraits(
      decodeFrame(buildFrame(fixtures.filter((trait) => isIdentity(trait.key)))).traits,
    )
    flushSync()

    harness.options.onTraits(
      decodeFrame(buildFrame(fixtures.filter((trait) => !isIdentity(trait.key)))).traits,
    )
    setTransportStatus({ observeFrames: 2, restCycles: 1, knownObjects: 1 })
    flushSync()

    const thermostat = api.registered.find(
      (accessory) => (accessory.context as { deviceId?: string }).deviceId === THERMOSTAT_ID,
    )

    expect(thermostat).toBeDefined()
    expect(thermostat!.displayName).toBe('Test Thermostat')
  })

  it('publishes REST Protects after the first app_launch', async () => {
    await launch()
    flushSync()

    expect(api.registered.some((accessory) => accessory.displayName.includes('Zone One')
      || (accessory.context as { deviceId?: string }).deviceId === PROTECT_ID)).toBe(true)
    expect(log.infos.join('\n')).toContain('Connected to Nest')
    expect(log.infos.join('\n')).toContain('Platform ready')
  })

  // config.schema.json points the user at this log line as the only way to find
  // a value for ignoredDeviceIds, so the id has to stay in it.
  it('logs the device id when adding an accessory', async () => {
    await launch()
    flushSync()

    const added = log.infos.filter((line) => line.startsWith('Adding '))

    expect(added.length).toBeGreaterThan(0)
    expect(added.join('\n')).toContain(`[${PROTECT_ID}]`)
  })

  it('refreshes a thermostat when the Temperature Sensor it follows changes', async () => {
    await launch()
    flushSync()

    const thermostatResource = `DEVICE_${THERMOSTAT_ID}`
    const sensorResource = 'DEVICE_SENSOR01'
    harness.options.onTraits(decodeFrame(buildFrame([
      ...heatingThermostatTraits(thermostatResource),
      {
        resourceId: thermostatResource,
        key: 'remote_comfort_sensing_settings',
        typeName: 'nest.trait.hvac.RemoteComfortSensingSettingsTrait',
        value: {
          activeRcsSelection: {
            rcsSourceType: 'RCS_SOURCE_TYPE_SINGLE_SENSOR',
            activeRcsSensor: { resourceId: sensorResource },
          },
        },
      },
      {
        resourceId: sensorResource,
        key: 'device_identity',
        typeName: 'weave.trait.description.DeviceIdentityTrait',
        value: { serialNumber: 'SENSOR01' },
      },
      {
        resourceId: sensorResource,
        key: 'label',
        typeName: 'weave.trait.description.LabelSettingsTrait',
        value: { label: 'Hall Sensor' },
      },
      {
        resourceId: sensorResource,
        key: 'temperature',
        typeName: 'nest.trait.sensor.TemperatureTrait',
        value: { temperature: { value: { value: 18 } } },
      },
    ])).traits)
    flushSync()

    const thermostat = api.registered.find(
      (accessory) => (accessory.context as { deviceId?: string }).deviceId === THERMOSTAT_ID,
    )
    const current = thermostat!
      .getService(Service.Thermostat)!
      .getCharacteristic(Characteristic.CurrentTemperature)

    expect(current.value).toBe(18)

    harness.options.onTraits(decodeFrame(buildFrame([{
      resourceId: sensorResource,
      key: 'temperature',
      typeName: 'nest.trait.sensor.TemperatureTrait',
      value: { temperature: { value: { value: 22.5 } } },
    }])).traits)
    flushSync()

    expect(current.value).toBe(22.5)
  })

  it('publishes Observe-only thermostats and Protects from the union', async () => {
    await launch()
    flushSync()

    harness.options.onTraits([
      ...thermostatTraits(),
      ...protectTraitsFor(PROTECT_ID),
      ...protectTraitsFor(OBSERVE_ONLY_PROTECT_ID),
    ])
    setTransportStatus({
      hasSession: true,
      observeFrames: 1,
      restCycles: 1,
      knownObjects: 1,
    })
    flushSync()

    const deviceIds = api.registered.map(
      (accessory) => (accessory.context as { deviceId?: string }).deviceId,
    )
    expect(deviceIds).toEqual(expect.arrayContaining([
      THERMOSTAT_ID,
      PROTECT_ID,
      OBSERVE_ONLY_PROTECT_ID,
    ]))

    // Homebridge 2 room tiles need a real HAP category at register time.
    const byId = new Map(
      api.registered.map((accessory) => [
        (accessory.context as { deviceId?: string }).deviceId,
        accessory.category,
      ]),
    )
    expect(byId.get(THERMOSTAT_ID)).toBe(Categories.THERMOSTAT)
    expect(byId.get(PROTECT_ID)).toBe(Categories.SENSOR)
    expect(byId.get(OBSERVE_ONLY_PROTECT_ID)).toBe(Categories.SENSOR)
  })

  it('adopts a cached accessory instead of registering a duplicate', async () => {
    const cachedUuid = uuid.generate(`${UUID_PREFIX}${PROTECT_ID}`)
    const cached = new Accessory('Zone One Protect', cachedUuid) as unknown as PlatformAccessory
    cached.context = { deviceId: PROTECT_ID, kind: 'protect', displayName: 'Zone One Protect' }

    const platform = new MyNestPlatform(
      log,
      {
        platform: PLATFORM_NAME,
        accessToken: 'b'.repeat(120),
      },
      api.asApi(),
    )
    platform.configureAccessory(cached)

    api.emit('didFinishLaunching')
    await Promise.resolve()
    await Promise.resolve()
    flushSync()

    expect(api.registered).toHaveLength(0)
    expect(api.updated).toContain(cached)
  })

  it('does not remove stale accessories while Observe has never connected', async () => {
    const staleUuid = uuid.generate(`${UUID_PREFIX}GONE`)
    const stale = new Accessory('Gone Thermostat', staleUuid) as unknown as PlatformAccessory
    stale.context = { deviceId: 'GONE', kind: 'thermostat', displayName: 'Gone Thermostat' }

    const platform = new MyNestPlatform(
      log,
      {
        platform: PLATFORM_NAME,
        accessToken: 'b'.repeat(120),
      },
      api.asApi(),
    )
    platform.configureAccessory(stale)
    api.emit('didFinishLaunching')
    await Promise.resolve()
    await Promise.resolve()
    flushSync()

    // REST app_launch already ran; Observe has not. Removing now would delete
    // cached thermostats that only Observe will report.
    expect(api.unregistered).toHaveLength(0)

    // Still REST-only after the old grace window — keep the cache. An Observe
    // outage at boot must not bounce rooms/automations.
    setTransportStatus({
      hasSession: true,
      observeFrames: 0,
      restCycles: 1,
      knownObjects: 1,
    })
    jest.advanceTimersByTime(60_000)
    flushSync()

    expect(api.unregistered).toHaveLength(0)
  })

  async function settleObserveSnapshot(): Promise<void> {
    flushSync()
    jest.advanceTimersByTime(750)
    flushSync()
  }

  it('prunes Observe-only devices omitted from two consecutive reconnect snapshots', async () => {
    await launch()
    flushSync()

    harness.options.onObserveSessionStart?.()
    harness.options.onTraits([
      ...thermostatTraits(),
      ...protectTraitsFor(OBSERVE_ONLY_PROTECT_ID),
    ])
    setTransportStatus({
      hasSession: true,
      observeFrames: 2,
      restCycles: 1,
      knownObjects: 1,
    })
    await settleObserveSnapshot()

    const before = api.registered.map(
      (accessory) => (accessory.context as { deviceId?: string }).deviceId,
    )
    expect(before).toEqual(expect.arrayContaining([THERMOSTAT_ID, OBSERVE_ONLY_PROTECT_ID]))

    // First omission only marks a removal candidate — truncated reconnects must
    // not delete a device Nest is about to re-send on the next frame.
    harness.options.onObserveSessionStart?.()
    harness.options.onTraits(thermostatTraits())
    setTransportStatus({
      hasSession: true,
      observeFrames: 3,
      restCycles: 1,
      knownObjects: 1,
    })
    await settleObserveSnapshot()
    expect(api.unregistered).toHaveLength(0)

    // Second consecutive snapshot without the Protect confirms removal.
    harness.options.onObserveSessionStart?.()
    harness.options.onTraits(thermostatTraits())
    setTransportStatus({
      hasSession: true,
      observeFrames: 4,
      restCycles: 1,
      knownObjects: 1,
    })
    await settleObserveSnapshot()

    const removedIds = api.unregistered.map(
      (accessory) => (accessory.context as { deviceId?: string }).deviceId,
    )
    expect(removedIds).toContain(OBSERVE_ONLY_PROTECT_ID)
    expect(removedIds).not.toContain(THERMOSTAT_ID)
    expect(log.infos.join('\n')).toMatch(/no longer reported/i)
  })

  it('does not prune when a reconnect snapshot looks truncated', async () => {
    await launch()
    flushSync()

    harness.options.onObserveSessionStart?.()
    harness.options.onTraits([
      ...thermostatTraits(),
      ...protectTraitsFor(OBSERVE_ONLY_PROTECT_ID),
      ...protectTraitsFor('PROTECT98'),
    ])
    setTransportStatus({
      hasSession: true,
      observeFrames: 3,
      restCycles: 1,
      knownObjects: 1,
    })
    await settleObserveSnapshot()

    // 1 of 3 devices is less than half — treat as incomplete, keep all three.
    harness.options.onObserveSessionStart?.()
    harness.options.onTraits(thermostatTraits())
    setTransportStatus({
      hasSession: true,
      observeFrames: 4,
      restCycles: 1,
      knownObjects: 1,
    })
    await settleObserveSnapshot()

    expect(api.unregistered).toHaveLength(0)
    expect(log.warns.join('\n')).toMatch(/incomplete/i)
  })

  it('clears a removal candidate when a truncated snapshot still names the device', async () => {
    await launch()
    flushSync()

    harness.options.onObserveSessionStart?.()
    harness.options.onTraits([
      ...thermostatTraits(),
      ...protectTraitsFor(OBSERVE_ONLY_PROTECT_ID),
      ...protectTraitsFor('PROTECT98'),
    ])
    setTransportStatus({
      hasSession: true,
      observeFrames: 3,
      restCycles: 1,
      knownObjects: 1,
    })
    await settleObserveSnapshot()

    // Complete snapshot omits Protect99 — first strike.
    harness.options.onObserveSessionStart?.()
    harness.options.onTraits([
      ...thermostatTraits(),
      ...protectTraitsFor('PROTECT98'),
    ])
    setTransportStatus({
      hasSession: true,
      observeFrames: 4,
      restCycles: 1,
      knownObjects: 1,
    })
    await settleObserveSnapshot()
    expect(api.unregistered).toHaveLength(0)

    // Truncated burst re-names Protect99 among a tiny set — must clear its strike
    // so the next complete snapshot cannot delete it after a single omission.
    harness.options.onObserveSessionStart?.()
    harness.options.onTraits(protectTraitsFor(OBSERVE_ONLY_PROTECT_ID))
    setTransportStatus({
      hasSession: true,
      observeFrames: 5,
      restCycles: 1,
      knownObjects: 1,
    })
    await settleObserveSnapshot()
    expect(log.warns.join('\n')).toMatch(/incomplete/i)

    // Next complete snapshot omits Protect99 again — still only one strike.
    harness.options.onObserveSessionStart?.()
    harness.options.onTraits([
      ...thermostatTraits(),
      ...protectTraitsFor('PROTECT98'),
    ])
    setTransportStatus({
      hasSession: true,
      observeFrames: 6,
      restCycles: 1,
      knownObjects: 1,
    })
    await settleObserveSnapshot()

    const removedIds = api.unregistered.map(
      (accessory) => (accessory.context as { deviceId?: string }).deviceId,
    )
    expect(removedIds).not.toContain(OBSERVE_ONLY_PROTECT_ID)
  })

  it('does not prune while the opening Observe burst is still landing', async () => {
    const cachedUuid = uuid.generate(`${UUID_PREFIX}${THERMOSTAT_ID}`)
    const cached = new Accessory('Zone One Thermostat', cachedUuid) as unknown as PlatformAccessory
    cached.context = {
      deviceId: THERMOSTAT_ID,
      kind: 'thermostat',
      displayName: 'Zone One Thermostat',
    }

    const platform = new MyNestPlatform(
      log,
      {
        platform: PLATFORM_NAME,
        accessToken: 'b'.repeat(120),
      },
      api.asApi(),
    )
    platform.configureAccessory(cached)
    api.emit('didFinishLaunching')
    await Promise.resolve()
    await Promise.resolve()
    flushSync()

    // REST-only inventory + Observe session open with frames, but the DEVICE
    // burst has not settled — pruning now would bounce every thermostat.
    harness.options.onObserveSessionStart?.()
    setTransportStatus({
      hasSession: true,
      observeFrames: 2,
      restCycles: 1,
      knownObjects: 1,
    })
    flushSync()

    expect(api.unregistered).toHaveLength(0)
  })

  it('removes a never-seen cached accessory only after a second settled snapshot', async () => {
    const staleUuid = uuid.generate(`${UUID_PREFIX}GONE`)
    const stale = new Accessory('Gone Protect', staleUuid) as unknown as PlatformAccessory
    stale.context = { deviceId: 'GONE', kind: 'protect', displayName: 'Gone Protect' }

    const platform = new MyNestPlatform(
      log,
      {
        platform: PLATFORM_NAME,
        accessToken: 'b'.repeat(120),
      },
      api.asApi(),
    )
    platform.configureAccessory(stale)
    api.emit('didFinishLaunching')
    await Promise.resolve()
    await Promise.resolve()

    // Observe-only account: opening burst must settle before HomeKit prune.
    harness.options.onBuckets({})
    harness.options.onObserveSessionStart?.()
    harness.options.onTraits(thermostatTraits())
    setTransportStatus({
      hasSession: true,
      observeFrames: 1,
      restCycles: 0,
      knownObjects: 0,
    })
    await settleObserveSnapshot()
    // One snapshot after a restart has no history for a cache-only device.
    expect(api.unregistered).not.toContain(stale)

    harness.options.onObserveSessionStart?.()
    harness.options.onTraits(thermostatTraits())
    setTransportStatus({
      hasSession: true,
      observeFrames: 2,
      restCycles: 0,
      knownObjects: 0,
    })
    await settleObserveSnapshot()

    expect(api.unregistered).toContain(stale)
    expect(log.infos.join('\n')).toContain('Gone Protect')
  })

  it('faults a cached Protect before Nest has connected', async () => {
    const cachedUuid = uuid.generate(`${UUID_PREFIX}PROTECT01`)
    const cached = new Accessory('Zone One Protect', cachedUuid) as unknown as PlatformAccessory
    cached.context = { deviceId: 'PROTECT01', kind: 'protect', displayName: 'Zone One Protect' }
    const smoke = cached.addService(api.hap.Service.SmokeSensor)
    smoke.getCharacteristic(api.hap.Characteristic.SmokeDetected).updateValue(
      api.hap.Characteristic.SmokeDetected.SMOKE_DETECTED,
    )
    smoke.getCharacteristic(api.hap.Characteristic.StatusActive).updateValue(true)
    smoke.getCharacteristic(api.hap.Characteristic.StatusFault).updateValue(
      api.hap.Characteristic.StatusFault.NO_FAULT,
    )

    const platform = new MyNestPlatform(
      log,
      { platform: PLATFORM_NAME, accessToken: 'b'.repeat(120) },
      api.asApi(),
    )
    platform.configureAccessory(cached)

    expect(smoke.getCharacteristic(api.hap.Characteristic.StatusActive).value).toBe(false)
    expect(smoke.getCharacteristic(api.hap.Characteristic.StatusFault).value)
      .toBe(api.hap.Characteristic.StatusFault.GENERAL_FAULT)
    await expect(smoke.getCharacteristic(api.hap.Characteristic.SmokeDetected).handleGetRequest())
      .resolves.toBe(api.hap.Characteristic.SmokeDetected.SMOKE_DETECTED)
    const detected = smoke.getCharacteristic(api.hap.Characteristic.SmokeDetected)
    detected.iid = 1
    const listed = await detected.toHAP(undefined as never, true)
    expect(listed.value).toBe(api.hap.Characteristic.SmokeDetected.SMOKE_DETECTED)
  })

  it('does not tell the operator to paste a token when the session shape changed', async () => {
    pendingStartFailures.push(new SessionShapeError(['userid']))
    await launch()

    expect(log.errors.join('\n')).toMatch(/session format/)
    expect(log.errors.join('\n')).not.toMatch(/Get a new token/)
  })

  it('keeps cached accessories when configuration is unusable', async () => {
    // Unregistering here destroys the user's room assignments, scene
    // memberships, and automation targets — and fixing the config does not
    // bring them back, because HomeKit treats re-registered accessories as new
    // devices. A config typo cannot warrant a more destructive response than a
    // revoked token, which deliberately keeps them.
    const staleUuid = uuid.generate(`${UUID_PREFIX}BAD`)
    const stale = new Accessory('Stale', staleUuid) as unknown as PlatformAccessory
    stale.context = { deviceId: 'BAD', kind: 'protect', displayName: 'Stale' }

    const platform = new MyNestPlatform(
      log,
      { platform: PLATFORM_NAME },
      api.asApi(),
    )
    platform.configureAccessory(stale)
    api.emit('didFinishLaunching')
    await Promise.resolve()

    expect(api.unregistered).not.toContain(stale)
    expect(log.errors.join('\n')).toContain('Access Token is required')
  })

  it('logs the raw topaz fields at debug when a Protect object arrives', async () => {
    await launch({ debug: true })
    flushSync()

    harness.options.onBuckets(restBuckets, [`topaz.${PROTECT_ID}`])

    expect(log.debugs.join('\n')).toContain(
      'REST topaz auto_away=false smoke_status=0 co_status=0',
    )
    expect(log.infos.join('\n')).not.toContain('REST topaz')
  })

  it('keeps a temperature sensor healthy through a quiet half hour', async () => {
    await launch()
    flushSync()

    harness.options.onBuckets({
      ...restBuckets,
      kryptonite: {
        SENSOR01: {
          serial_number: 'SENSOR01',
          current_temperature: 21,
          battery_level: 80,
          description: 'Study Sensor',
        },
      },
    }, ['kryptonite.SENSOR01'])
    flushSync()

    // Observe sends device traits only on change, so silence is not an outage.
    jest.advanceTimersByTime(30 * 60_000)
    flushSync()

    const sensor = api.registered.find(
      (accessory) => (accessory.context as { deviceId?: string }).deviceId === 'SENSOR01',
    )
    expect(sensor).toBeDefined()
    expect(
      sensor!.getService(api.hap.Service.TemperatureSensor)!
        .getCharacteristic(api.hap.Characteristic.StatusFault).value,
    ).toBe(api.hap.Characteristic.StatusFault.NO_FAULT)
    expect(log.warns.join('\n')).not.toContain('temperature sensors')
  })

  it('keeps the other accessories updating when one accessory throws', async () => {
    const { NestAccessory } = await import('../../src/accessories/base')
    await launch({ debug: true })
    flushSync()

    const spy = jest.spyOn(NestAccessory.prototype, 'update').mockImplementationOnce(() => {
      throw new Error('protect blew up')
    })

    harness.options.onBuckets(restBuckets, [`topaz.${PROTECT_ID}`])
    flushSync()

    expect(log.errors.join('\n')).toContain('protect blew up')
    expect(log.debugs.join('\n')).toContain('REST topaz auto_away=false')
    spy.mockRestore()
  })

  it('keeps published accessories when Nest authentication fails permanently', async () => {
    await launch()
    flushSync()
    expect(api.registered.length).toBeGreaterThan(0)
    const published = api.registered.length

    const protect = api.registered.find(
      (accessory) => (accessory.context as { deviceId?: string }).deviceId === PROTECT_ID,
    )
    expect(protect).toBeDefined()
    const smoke = protect!.getService(api.hap.Service.SmokeSensor)
    expect(smoke).toBeDefined()
    expect(smoke!.getCharacteristic(api.hap.Characteristic.StatusActive).value).toBe(true)

    harness.options.onFatal(new AuthenticationError('Nest rejected the access token'))
    await Promise.resolve()

    // Token expiry needs a manual paste + restart — not accessory churn.
    expect(api.unregistered).toHaveLength(0)
    expect(api.registered).toHaveLength(published)
    expect(log.errors.join('\n')).toMatch(/home\.nest\.com\/session/)
    expect(log.errors.join('\n')).toMatch(/Nest token rejected/)
    // Last readings stay, but must not look like a live all-clear after auth dies.
    expect(smoke!.getCharacteristic(api.hap.Characteristic.StatusActive).value).toBe(false)
    expect(smoke!.getCharacteristic(api.hap.Characteristic.StatusFault).value)
      .toBe(api.hap.Characteristic.StatusFault.GENERAL_FAULT)
  })

  describeWithSqlite('PagerDuty signals', () => {
    let storagePath: string

    const storeDir = (): string => join(storagePath, 'homebridge-pagerduty')

    function readSignals(): Record<string, number> {
      const db = new sqlite!.DatabaseSync(join(storeDir(), 'signals-2026-10-24', 'signals.sqlite'))
      try {
        const rows = db.prepare('SELECT signal, active FROM signals').all() as unknown as {
          signal: string
          active: number
        }[]
        return Object.fromEntries(rows.map((row) => [row.signal, row.active]))
      } finally {
        db.close()
      }
    }

    const startupLines = (): string[] =>
      log.infos.filter((line) => line.includes('homebridge-pagerduty support is enabled'))

    beforeEach(() => {
      storagePath = mkdtempSync(join(tmpdir(), 'mynest-platform-signals-'))
      api.storagePath = storagePath
    })

    afterEach(() => {
      api.emit('shutdown')
      rmSync(storagePath, { recursive: true, force: true })
    })

    it('creates no store and logs no startup line when the setting is off', async () => {
      await launch()
      flushSync()

      expect(existsSync(storeDir())).toBe(false)
      expect(startupLines()).toEqual([])
    })

    it('logs the startup line once and writes every signal clear at startup', async () => {
      await launch({ pagerdutySignals: true })
      flushSync()

      expect(startupLines()).toEqual([PAGERDUTY_STARTUP_LOG])
      expect(readSignals()).toEqual({ 'smoke': 0, 'co': 0, 'alarm-feed-stale': 0, 'auth-failed': 0 })
    })

    it('raises smoke when a Protect reports an emergency', async () => {
      await launch({ pagerdutySignals: true })
      flushSync()

      harness.options.onBuckets(
        { topaz: { [PROTECT_ID]: { ...restBuckets.topaz![PROTECT_ID]!, smoke_status: 2 } } },
        [`topaz.${PROTECT_ID}`],
      )
      flushSync()

      expect(readSignals()).toEqual(expect.objectContaining({ smoke: 1, co: 0 }))
    })

    it('does not log the startup line again when startup retries', async () => {
      pendingStartFailures.push(new NetworkError('Could not reach https://home.nest.com/session'))
      await launch({ pagerdutySignals: true })
      await jest.advanceTimersByTimeAsync(60_000)

      expect(log.infos.join('\n')).toContain('Connected to Nest')
      expect(startupLines()).toHaveLength(1)
    })

    it('raises auth-failed on a rejected token and keeps it through shutdown', async () => {
      await launch({ pagerdutySignals: true })
      flushSync()

      harness.options.onFatal(new AuthenticationError('Nest rejected the access token'))
      api.emit('shutdown')

      expect(readSignals()).toEqual(expect.objectContaining({ 'auth-failed': 1, 'alarm-feed-stale': 0 }))
    })

    it('raises auth-failed when the configuration is unusable', async () => {
      new MyNestPlatform(log, { platform: PLATFORM_NAME, pagerdutySignals: true }, api.asApi())
      api.emit('didFinishLaunching')
      await Promise.resolve()

      expect(startupLines()).toHaveLength(1)
      expect(readSignals()).toEqual({ 'auth-failed': 1, 'alarm-feed-stale': 0 })
    })
  })
})
