/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Platform diagnostics lifecycle: start, heartbeat, stop, transitions.
 */

import type { NestTransportOptions, TransportStatus } from '../../src/api/transport'
import { PLATFORM_NAME } from '../../src/settings'
import { createHomebridgeLogging, FakeHomebridgeApi } from '../helpers/homebridge'

interface TransportHarness {
  options: NestTransportOptions
  status: TransportStatus
  start: jest.Mock
  stop: jest.Mock
}

let harness: TransportHarness

jest.mock('../../src/api/transport', () => {
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
          observeFrames: 1,
          restCycles: 1,
          knownObjects: 1,
          observeState: 'connected',
          restState: 'running',
          lastObserveFrameAgeSec: 1,
          lastRestSuccessAgeSec: 1,
          isRestAlarmFeedAvailable: true,
  isDecodeDegraded: false,
          circuitBreaker: {
            rest: { ...closedBreaker },
            observe: { ...closedBreaker },
          },
        },
        start: jest.fn(async () => {
          options.onBuckets({
            topaz: {
              PROTECT01: {
                serial_number: 'PROTECT01',
                smoke_status: 0,
                co_status: 0,
                line_power_present: true,
                auto_away: false,
                description: 'Hallway',
              },
            },
          })
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

describe('MyNestPlatform diagnostics', () => {
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
        diagnosticsInterval: 60,
        ...overrides,
      },
      api.asApi(),
    )
    api.emit('didFinishLaunching')
    await Promise.resolve()
    await Promise.resolve()
    jest.advanceTimersByTime(250)
    return platform
  }

  it('emits a diagnostics start snapshot when enabled', async () => {
    await launch()
    expect(log.infos.join('\n')).toMatch(/Diagnostics start: healthy/)
    expect(harness.options.statusHeartbeatEnabled).toBe(false)
  })

  it('emits periodic Health heartbeats', async () => {
    await launch()
    log.infos.length = 0

    jest.advanceTimersByTime(60_000)
    expect(log.infos.join('\n')).toMatch(/^Health: healthy/m)
  })

  it('emits a stop snapshot on shutdown', async () => {
    await launch()
    log.infos.length = 0
    api.emit('shutdown')

    expect(log.infos.join('\n')).toMatch(/Diagnostics stop:/)
    expect(harness.stop).toHaveBeenCalled()
  })

  it('emits Health degraded when Observe goes silent past the grace window', async () => {
    await launch()
    harness.status = {
      ...harness.status,
      observeState: 'connecting',
      lastObserveFrameAgeSec: 90,
    }

    jest.advanceTimersByTime(60_000)
    expect(log.warns.join('\n')).toMatch(/Health degraded: degraded \[observeDown\]/)
  })

  it('emits a structured JSON line when structuredLogs is on', async () => {
    await launch({ structuredLogs: true })
    const jsonLine = log.infos.find((line) => line.startsWith('{') && line.includes('"msg"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!) as { msg: string }
    expect(parsed.msg).toBe('diagnostics.start')
  })

  it('does not start diagnostics when the interval is zero', async () => {
    await launch({ diagnosticsInterval: 0 })
    expect(log.infos.join('\n')).not.toMatch(/Diagnostics start/)
    expect(harness.options.statusHeartbeatEnabled).toBe(true)
  })
})
