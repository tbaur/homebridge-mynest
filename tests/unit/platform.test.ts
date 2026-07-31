/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Platform lifecycle: restore, publish, merge sync, stale removal.
 */

import { Accessory, uuid } from '@homebridge/hap-nodejs'
import type { PlatformAccessory } from 'homebridge'
import { CircuitState } from '../../src/api/circuit-breaker'
import type { NestTransportOptions, TransportStatus } from '../../src/api/transport'
import type { TraitUpdate } from '../../src/api/protobuf'
import type { BucketMap } from '../../src/types/nest'
import { PLATFORM_NAME, UUID_PREFIX } from '../../src/settings'
import { createHomebridgeLogging, FakeHomebridgeApi } from '../helpers/homebridge'
import {
  buildFrame,
  heatingThermostatTraits,
  protectTraits,
} from '../helpers/observe-fixtures'
import { decodeFrame } from '../../src/api/protobuf'

interface TransportHarness {
  options: NestTransportOptions
  status: TransportStatus
  start: jest.Mock
  stop: jest.Mock
}

let harness: TransportHarness

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
          circuitBreaker: {
            rest: { ...closedBreaker },
            observe: { ...closedBreaker },
          },
        },
        start: jest.fn(async () => {
          // REST-first boot: buckets arrive before Observe frames.
          options.onBuckets(restBuckets)
        }),
        stop: jest.fn(),
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
  }

  return { NestTransport }
})

import { MyNestPlatform } from '../../src/platform'

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
      description: 'Hallway Protect',
    },
  },
}

function thermostatTraits(): readonly TraitUpdate[] {
  return decodeFrame(buildFrame(heatingThermostatTraits(`DEVICE_${THERMOSTAT_ID}`))).traits
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

  it('warns that thermostat writes are unsupported when the flag is on', async () => {
    await launch({ allowThermostatControl: true })
    expect(log.warns.join('\n')).toContain('Allow Thermostat Control ignored')
    expect(log.warns.join('\n')).toMatch(/read-only/i)
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

  it('publishes REST Protects after the first app_launch', async () => {
    await launch()
    flushSync()

    expect(api.registered.some((accessory) => accessory.displayName.includes('Hallway')
      || (accessory.context as { deviceId?: string }).deviceId === PROTECT_ID)).toBe(true)
    expect(log.infos.join('\n')).toContain('Connected to Nest')
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
  })

  it('adopts a cached accessory instead of registering a duplicate', async () => {
    const cachedUuid = uuid.generate(`${UUID_PREFIX}${PROTECT_ID}`)
    const cached = new Accessory('Hallway Protect', cachedUuid) as unknown as PlatformAccessory
    cached.context = { deviceId: PROTECT_ID, kind: 'protect', displayName: 'Hallway Protect' }

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
    expect(log.infos.join('\n')).toMatch(/Observe dropped|Nest no longer reports/i)
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
    const cached = new Accessory('Hallway Thermostat', cachedUuid) as unknown as PlatformAccessory
    cached.context = {
      deviceId: THERMOSTAT_ID,
      kind: 'thermostat',
      displayName: 'Hallway Thermostat',
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

  it('removes stale accessories once an Observe snapshot has settled', async () => {
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

    expect(api.unregistered).toContain(stale)
    expect(log.infos.join('\n')).toContain('Gone Protect')
  })

  it('unregisters cached accessories when configuration is unusable', async () => {
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

    expect(api.unregistered).toContain(stale)
    expect(log.warns.join('\n')).toContain('cached accessory')
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

    harness.options.onFatal(new Error('Nest rejected the access token'))
    await Promise.resolve()

    // Token expiry needs a manual paste + restart — not accessory churn.
    expect(api.unregistered).toHaveLength(0)
    expect(api.registered).toHaveLength(published)
    expect(log.errors.join('\n')).toMatch(/home\.nest\.com\/session/)
    expect(log.errors.join('\n')).toMatch(/Accessories were kept/)
    // Last readings stay, but must not look like a live all-clear after auth dies.
    expect(smoke!.getCharacteristic(api.hap.Characteristic.StatusActive).value).toBe(false)
    expect(smoke!.getCharacteristic(api.hap.Characteristic.StatusFault).value)
      .toBe(api.hap.Characteristic.StatusFault.GENERAL_FAULT)
  })
})
