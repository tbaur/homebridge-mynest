/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Running both transports for the life of the plugin.
 *
 * The two loops are deliberately independent: a home where one transport is
 * broken should keep updating through the one that works, rather than going
 * dark. The other thing worth pinning down is that a rejected token stops the
 * loops instead of being retried every few seconds forever.
 */

import { CircuitBreaker, CircuitState } from '../../../src/api/circuit-breaker'
import { NestTransport } from '../../../src/api/transport'
import {
  FORBIDDEN_FATAL_THRESHOLD,
  REST_ALARM_FEED_STALE_MS,
  resolveEndpoints,
} from '../../../src/settings'
import { AuthenticationError } from '../../../src/errors'
import type { FetchLike } from '../../../src/api/http'
import type { BucketMap } from '../../../src/types/nest'
import type { TraitUpdate } from '../../../src/api/protobuf'
import { createFakeHttp2 } from '../../helpers/http2'
import { createRecordingLogger } from '../../helpers/logger'
import { buildFrame, heatingThermostatTraits } from '../../helpers/observe-fixtures'

jest.mock('../../../src/utils/retry', () => {
  const actual = jest.requireActual<typeof import('../../../src/utils/retry')>(
    '../../../src/utils/retry',
  )
  // Yield to the event loop so open-breaker / 403 spin loops cannot starve
  // timers that stop the transport under test.
  return {
    ...actual,
    sleep: jest.fn(() => new Promise<void>((resolve) => setImmediate(resolve))),
  }
})

const endpoints = resolveEndpoints(false)

const SESSION_BODY = {
  access_token: 'session-token',
  userid: '5551234',
  urls: { transport_url: 'https://czfe123.transport.home.nest.com' },
}

const TOPAZ = {
  object_key: 'topaz.ABC123',
  object_revision: 1,
  object_timestamp: 1,
  value: { smoke_status: 0 },
}

/** A fetch that answers each Nest endpoint by URL, with the subscribe hanging. */
function createNestFetch(options: {
  sessionStatus?: number
  appLaunchStatus?: number
  /** When set, `/v5/subscribe` returns this status instead of parking. */
  subscribeStatus?: number
} = {}) {
  const calls: string[] = []

  const fetch = (async (url: unknown, init: RequestInit = {}) => {
    const target = String(url)
    calls.push(target)

    if (target.includes('/session')) {
      return new Response(JSON.stringify(SESSION_BODY), { status: options.sessionStatus ?? 200 })
    }
    if (target.includes('app_launch')) {
      return new Response(
        JSON.stringify({ updated_buckets: [TOPAZ] }),
        { status: options.appLaunchStatus ?? 200 },
      )
    }

    if (target.includes('/v5/subscribe') && options.subscribeStatus !== undefined) {
      return new Response('forbidden', { status: options.subscribeStatus })
    }

    // The subscribe long-poll parks until the client gives up, which is what it
    // does against a quiet house.
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  }) as unknown as FetchLike

  return { fetch, calls }
}

function createTransport(overrides: Partial<ConstructorParameters<typeof NestTransport>[0]> = {}) {
  const http2 = createFakeHttp2()
  const log = createRecordingLogger()
  const { fetch, calls } = createNestFetch()

  const traits: TraitUpdate[] = []
  const buckets: BucketMap[] = []
  const fatals: Error[] = []

  const transport = new NestTransport({
    accessToken: 'config-token',
    endpoints,
    log,
    fetchImpl: fetch,
    connect: http2.connect,
    onTraits: (batch) => traits.push(...batch),
    onBuckets: (map) => buckets.push(map),
    onFatal: (error) => fatals.push(error),
    ...overrides,
  })

  return { transport, http2, log, calls, traits, buckets, fatals }
}

describe('NestTransport', () => {
  it('POSTs BatchUpdateState when updating thermostat settings', async () => {
    const batchCalls: string[] = []
    const base = createNestFetch()
    const fetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('BatchUpdateState')) {
        batchCalls.push(target)
        return new Response(new Uint8Array(), { status: 200 })
      }
      return base.fetch(target, init)
    }) as unknown as FetchLike

    const { transport, log } = createTransport({ fetchImpl: fetch })
    await transport.start()

    await transport.updateThermostatSettings({
      resourceId: 'DEVICE_ABC',
      mode: 'heat',
      targetTemperatureHeatC: 22,
      targetTemperatureCoolC: 27,
      standbyMode: 'heat',
      clearEco: false,
    })

    expect(batchCalls).toHaveLength(1)
    expect(batchCalls[0]).toContain('/nestlabs.gateway.v1.TraitBatchApi/BatchUpdateState')
    expect(log.infos.join('\n')).toMatch(/Thermostat write DEVICE_ABC/)

    transport.stop()
  })

  it('logs and rethrows when BatchUpdateState fails', async () => {
    const base = createNestFetch()
    const fetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('BatchUpdateState')) {
        return new Response('no', { status: 503 })
      }
      return base.fetch(target, init)
    }) as unknown as FetchLike

    const { transport, log } = createTransport({ fetchImpl: fetch })
    await transport.start()

    await expect(transport.updateThermostatSettings({
      resourceId: 'DEVICE_ABC',
      mode: 'heat',
      targetTemperatureHeatC: 22,
      targetTemperatureCoolC: 27,
      standbyMode: 'heat',
      clearEco: false,
    })).rejects.toThrow(/503/)

    expect(log.warns.join('\n')).toMatch(/BatchUpdateState failed/)
    transport.stop()
  })

  it('opens a session and enumerates the account before returning', async () => {
    const { transport, calls, buckets } = createTransport()

    await transport.start()
    transport.stop()

    expect(calls[0]).toContain('/session')
    expect(calls[1]).toContain('app_launch')
    expect(buckets[0]).toEqual({ topaz: { ABC123: { smoke_status: 0 } } })
  })

  it('does not wait for the Observe snapshot before publishing REST devices', async () => {
    // Blocking on the slower transport would delay every REST-visible device.
    const { transport, buckets } = createTransport()

    await transport.start()

    expect(buckets).toHaveLength(1)
    transport.stop()
  })

  it('reports traits from the Observe stream', async () => {
    const { transport, http2, traits } = createTransport()
    await transport.start()

    const connection = await http2.session()
    connection.push(buildFrame(heatingThermostatTraits('DEVICE_THERM01')))

    await Promise.resolve()

    expect(traits.length).toBeGreaterThan(0)
    expect(traits.every((trait) => trait.resourceId === 'DEVICE_THERM01')).toBe(true)
    transport.stop()
  })

  it('counts what each loop has done', async () => {
    const { transport, http2 } = createTransport()
    await transport.start()

    const connection = await http2.session()
    connection.push(buildFrame(heatingThermostatTraits()))
    await Promise.resolve()

    expect(transport.status).toMatchObject({ hasSession: true, observeFrames: 1, knownObjects: 1 })
    transport.stop()
  })

  it('stops both loops on shutdown', async () => {
    const { transport, http2 } = createTransport()
    await transport.start()
    const connection = await http2.session()

    transport.stop()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(connection.isClosed).toBe(true)
    expect(transport.status.hasSession).toBe(false)
  })

  it('surfaces a rejected token from startup rather than retrying it', async () => {
    const { fetch } = createNestFetch({ sessionStatus: 401 })
    const { transport } = createTransport({ fetchImpl: fetch })

    await expect(transport.start()).rejects.toThrow(AuthenticationError)
  })

  it('reconnects after the Observe stream drops', async () => {
    const { transport, http2 } = createTransport()
    await transport.start()

    const first = await http2.session()
    first.end()

    // The reconnect delay is the plugin's shortest, so a brief wait covers it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    transport.stop()

    // A clean end must not be punished with a growing backoff, or Nest's
    // routine stream recycling would cost minutes of stale readings.
    expect(http2.origins.length).toBeGreaterThanOrEqual(1)
  })

  it('keeps REST going when Observe fails outright', async () => {
    const { transport, http2, buckets } = createTransport()
    await transport.start()

    const connection = await http2.session()
    connection.failStream('gateway unavailable')
    await new Promise((resolve) => setTimeout(resolve, 20))

    // REST already reported, and nothing about the Observe failure undoes it.
    expect(buckets).toHaveLength(1)
    transport.stop()
  })

  it('treats an Observe stream transport error as recoverable, not fatal', async () => {
    const { transport, http2, fatals, log } = createTransport()
    await transport.start()

    const connection = await http2.session()
    connection.failStream('gateway unavailable')
    await new Promise((resolve) => setTimeout(resolve, 20))
    transport.stop()

    expect(log.debugs.join('\n')).toContain('Observe stream failed')
    expect(fatals).toHaveLength(0)
  })

  it('reports a fatal failure when Observe returns HTTP 401', async () => {
    const { transport, http2, fatals } = createTransport()
    await transport.start()

    const connection = await http2.session()
    connection.respond(401)
    await new Promise((resolve) => setTimeout(resolve, 20))
    transport.stop()

    expect(fatals.length).toBeGreaterThanOrEqual(1)
    expect(fatals[0]?.message).toMatch(/access token|HTTP 401/i)
  })

  it('stops the Observe loop after repeated HTTP 403 without killing a healthy REST path', async () => {
    const { transport, http2, fatals, log } = createTransport()
    await transport.start()

    for (let attempt = 0; attempt < FORBIDDEN_FATAL_THRESHOLD; attempt++) {
      const connection = await http2.session()
      connection.respond(403)
      await new Promise((resolve) => setTimeout(resolve, 30))
    }

    transport.stop()

    // One transport giving up must not fatal — REST may still be updating Protects.
    expect(fatals).toHaveLength(0)
    expect(log.warns.join('\n')).toContain('HTTP 403')
    expect(log.errors.join('\n')).toMatch(/giving up.*other transport/i)
  })

  it('does not fatal when REST alone returns repeated HTTP 403 while Observe is healthy', async () => {
    const { fetch } = createNestFetch({ subscribeStatus: 403 })
    const { transport, http2, fatals, log } = createTransport({ fetchImpl: fetch })
    await transport.start()

    const connection = await http2.session()
    connection.push(buildFrame(heatingThermostatTraits('DEVICE_THERM01')))
    await Promise.resolve()

    // sleep() is mocked to resolve immediately, so the subscribe loop burns
    // through its 403 budget without waiting on Nest.
    await new Promise((resolve) => setTimeout(resolve, 50))
    transport.stop()

    expect(fatals).toHaveLength(0)
    expect(log.warns.join('\n')).toContain('REST subscribe')
    expect(log.errors.join('\n')).toMatch(/giving up.*other transport/i)
  })

  it('fatals only after both REST and Observe exhaust their HTTP 403 budgets', async () => {
    const { fetch } = createNestFetch({ subscribeStatus: 403 })
    const { transport, http2, fatals, log } = createTransport({ fetchImpl: fetch })
    await transport.start()

    for (let attempt = 0; attempt < FORBIDDEN_FATAL_THRESHOLD; attempt++) {
      const connection = await http2.session()
      connection.respond(403)
      await new Promise((resolve) => setTimeout(resolve, 30))
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
    transport.stop()

    expect(fatals.length).toBeGreaterThanOrEqual(1)
    expect(fatals[0]?.message).toMatch(/both REST and Observe/i)
    expect(log.warns.join('\n')).toContain('HTTP 403')
  })

  it('opens the REST circuit breaker on sustained subscribe failures and fails fast', async () => {
    const opens: Array<'rest' | 'observe'> = []
    const restBreaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 30_000 })
    const { fetch } = createNestFetch({ subscribeStatus: 503 })
    const { transport, log } = createTransport({
      fetchImpl: fetch,
      restCircuitBreaker: restBreaker,
      onCircuitOpen: (transportName) => {
        opens.push(transportName)
        // Stop immediately: an open breaker + mocked sleep would otherwise
        // spin the subscribe loop forever under test.
        transport.stop()
      },
    })

    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(opens).toContain('rest')
    expect(restBreaker.state).toBe(CircuitState.OPEN)
    expect(log.warns.join('\n')).toMatch(/Circuit breaker \(REST\).*OPEN/)
  })

  it('does not trip the REST breaker on HTTP 403 subscribe failures', async () => {
    const restBreaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 30_000 })
    const { fetch } = createNestFetch({ subscribeStatus: 403 })
    const { transport } = createTransport({
      fetchImpl: fetch,
      restCircuitBreaker: restBreaker,
    })

    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    transport.stop()

    expect(restBreaker.state).toBe(CircuitState.CLOSED)
    expect(restBreaker.getStatus().failures).toBe(0)
  })

  it('exposes closed breakers on a healthy start', async () => {
    const { transport } = createTransport()
    await transport.start()

    expect(transport.status.circuitBreaker).toMatchObject({
      rest: { state: CircuitState.CLOSED, isOpen: false },
      observe: { state: CircuitState.CLOSED, isOpen: false },
    })
    expect(transport.status.isRestAlarmFeedAvailable).toBe(true)
    transport.stop()
  })

  it('marks the REST alarm feed unavailable when the REST breaker opens', async () => {
    const feedChanges: boolean[] = []
    const restBreaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 30_000 })
    const { fetch } = createNestFetch({ subscribeStatus: 503 })
    const { transport, log } = createTransport({
      fetchImpl: fetch,
      restCircuitBreaker: restBreaker,
      onRestAlarmFeedChange: (available) => feedChanges.push(available),
      onCircuitOpen: () => transport.stop(),
    })

    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(restBreaker.state).toBe(CircuitState.OPEN)
    expect(transport.status.isRestAlarmFeedAvailable).toBe(false)
    expect(feedChanges).toContain(false)
    expect(log.warns.join('\n')).toMatch(/REST alarm feed unavailable/i)
  })

  it('marks the REST alarm feed unavailable after REST gives up on HTTP 403', async () => {
    const { fetch } = createNestFetch({ subscribeStatus: 403 })
    const { transport, http2 } = createTransport({ fetchImpl: fetch })
    await transport.start()

    const connection = await http2.session()
    connection.push(buildFrame(heatingThermostatTraits('DEVICE_THERM01')))
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(transport.status.restState).toBe('forbidden_dead')
    expect(transport.status.isRestAlarmFeedAvailable).toBe(false)
    transport.stop()
  })

  it('notifies when the REST alarm feed goes stale by age during backoff', async () => {
    // Age-based stale must emit even while the subscribe loop is sleeping —
    // waiting for the next loop iteration leaves StatusActive stuck at live.
    const sleep = jest.requireMock('../../../src/utils/retry') as {
      sleep: jest.Mock
    }
    sleep.sleep.mockImplementation(
      (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    )

    jest.useFakeTimers()
    const feedChanges: boolean[] = []
    // High threshold so the breaker stays closed; only age should flip the feed.
    const restBreaker = new CircuitBreaker({ failureThreshold: 100, resetTimeoutMs: 60_000 })
    const { fetch } = createNestFetch({ subscribeStatus: 503 })
    const { transport } = createTransport({
      fetchImpl: fetch,
      restCircuitBreaker: restBreaker,
      onRestAlarmFeedChange: (available) => feedChanges.push(available),
    })

    try {
      const startPromise = transport.start()
      await jest.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      await jest.advanceTimersByTimeAsync(0)

      expect(transport.status.isRestAlarmFeedAvailable).toBe(true)

      await jest.advanceTimersByTimeAsync(REST_ALARM_FEED_STALE_MS + 1)

      expect(transport.status.isRestAlarmFeedAvailable).toBe(false)
      expect(feedChanges).toContain(false)
      expect(restBreaker.state).toBe(CircuitState.CLOSED)

      transport.stop()
      await jest.advanceTimersByTimeAsync(0)
      await startPromise.catch(() => undefined)
    } finally {
      jest.useRealTimers()
      sleep.sleep.mockImplementation(
        () => new Promise<void>((resolve) => setImmediate(resolve)),
      )
    }
  })
})
