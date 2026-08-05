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
  FRAME_DECODE_WINDOW,
  OBSERVE_IDLE_TIMEOUT_MS,
  REST_ALARM_FEED_STALE_MS,
  REST_RESPONSE_STALE_MS,
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

/**
 * Poll a condition instead of sleeping a fixed span.
 *
 * The `sleep` mock resolves via `setImmediate`, so a loop whose request fails
 * instantly can starve a `setTimeout`. Yielding through a timer each round
 * keeps the timers phase reachable.
 */
async function waitUntil(condition: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
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
  it('shares one session open across concurrent callers', async () => {
    // Four call sites can race for a session: both run loops, app_launch, and
    // every write. Each caller that arrived during an in-flight open used to
    // start its own, so a five-thermostat global Eco press against a stale
    // session became fifteen authentication requests.
    const base = createNestFetch()
    let sessionCalls = 0
    const fetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('/session')) {
        sessionCalls++
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      if (target.includes('BatchUpdateState')) {
        return new Response(new Uint8Array(), { status: 200 })
      }
      return base.fetch(target, init)
    }) as unknown as FetchLike

    const { transport } = createTransport({ fetchImpl: fetch })
    await transport.start()

    const opensAfterStart = sessionCalls

    await Promise.all(Array.from({ length: 5 }, () =>
      transport.updateEcoMode('DEVICE_ABC', true)))

    // The session from start() is still fresh, so none of the five should have
    // re-opened it — and even if one had, the other four would share it.
    expect(sessionCalls).toBe(opensAfterStart)

    transport.stop()
  })

  it('does not re-open the session for an ordinary network failure', async () => {
    // Forcing a refresh on every retryable error turned one failed request into
    // four (the open itself retries), did it on both loops at once during any
    // shared outage, and answered an HTTP 429 by issuing more requests. A DNS
    // blip says nothing about whether the session is still valid.
    //
    // The transport is stopped from inside the fetch once enough subscribe
    // attempts have been observed: a 500 returns instantly, so letting the loop
    // run against a wall-clock timeout would spin.
    let sessionCalls = 0
    let subscribeCalls = 0
    let stop = (): void => undefined

    const fetch = (async (url: unknown) => {
      const target = String(url)
      if (target.includes('/session')) {
        sessionCalls++
        return new Response(JSON.stringify(SESSION_BODY), { status: 200 })
      }
      if (target.includes('app_launch')) {
        return new Response(JSON.stringify({ updated_buckets: [TOPAZ] }), { status: 200 })
      }
      subscribeCalls++
      if (subscribeCalls >= 4) {
        stop()
      }
      return new Response('upstream boom', { status: 500 })
    }) as unknown as FetchLike

    const { transport } = createTransport({ fetchImpl: fetch })
    stop = () => transport.stop()

    await transport.start()
    const opensAfterStart = sessionCalls

    await waitUntil(() => subscribeCalls >= 4)
    transport.stop()

    expect(subscribeCalls).toBeGreaterThanOrEqual(4)
    expect(sessionCalls).toBe(opensAfterStart)
  })

  it('treats a 401 on subscribe as fatal rather than retrying it forever', async () => {
    // 401 is the one shape that actually implicates the session, so unlike an
    // ordinary network failure it must not be retried indefinitely.
    let subscribeCalls = 0
    let stop = (): void => undefined

    const fetch = (async (url: unknown) => {
      const target = String(url)
      if (target.includes('/session')) {
        return new Response(JSON.stringify(SESSION_BODY), { status: 200 })
      }
      if (target.includes('app_launch')) {
        return new Response(JSON.stringify({ updated_buckets: [TOPAZ] }), { status: 200 })
      }
      subscribeCalls++
      if (subscribeCalls >= 2) {
        stop()
      }
      return new Response('nope', { status: 401 })
    }) as unknown as FetchLike

    const { transport, fatals } = createTransport({ fetchImpl: fetch })
    stop = () => transport.stop()

    await transport.start()
    await waitUntil(() => fatals.length > 0 || subscribeCalls >= 2)
    transport.stop()

    // 401 is AuthenticationError, which is fatal rather than retried forever.
    expect(fatals.length).toBeGreaterThan(0)
  })

  it('warns when Nest frames stop decoding altogether', async () => {
    // A pinned web-app version against an unversioned API means a Nest schema
    // change is the likeliest way this breaks, and its signature is every frame
    // decoding to nothing while the frame counter climbs and health stays green.
    const { transport, log, http2 } = createTransport()
    await transport.start()
    const connection = await http2.session()

    // Correctly framed but not a StreamBody: a length-prefixed run of 0xff.
    const garbage = Buffer.concat([
      Buffer.from([0x00, 0x05]),
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]),
    ])
    for (let i = 0; i < FRAME_DECODE_WINDOW + 5; i++) {
      connection.push(garbage)
    }
    transport.stop()

    expect(log.warns.join('\n')).toContain('could not be')
    expect(log.warns.join('\n')).toContain('decoded')
  })

  it('merges and publishes buckets when subscribe reports a change', async () => {
    // The happy path of the REST loop: a subscribe that actually returns data,
    // rather than parking until the client gives up.
    const changed = {
      object_key: 'topaz.ABC123',
      object_revision: 2,
      object_timestamp: 2,
      value: { smoke_status: 1 },
    }
    let subscribeCalls = 0
    let stop = (): void => undefined

    const fetch = (async (url: unknown) => {
      const target = String(url)
      if (target.includes('/session')) {
        return new Response(JSON.stringify(SESSION_BODY), { status: 200 })
      }
      if (target.includes('app_launch')) {
        return new Response(JSON.stringify({ updated_buckets: [TOPAZ] }), { status: 200 })
      }
      subscribeCalls++
      if (subscribeCalls >= 2) {
        stop()
      }
      return new Response(JSON.stringify({ objects: [changed] }), { status: 200 })
    }) as unknown as FetchLike

    const { transport, buckets } = createTransport({ fetchImpl: fetch })
    stop = () => transport.stop()

    await transport.start()
    await waitUntil(() => buckets.length >= 2)
    transport.stop()

    // The revision the subscribe returned replaced the app_launch one.
    const latest = buckets[buckets.length - 1]!
    expect((latest.topaz as Record<string, { smoke_status?: number }>).ABC123.smoke_status).toBe(1)
    expect(transport.status.restCycles).toBeGreaterThan(0)
  })

  it('reports deltas and ages on the periodic status line', async () => {
    const { transport, log } = createTransport({ statusHeartbeatMs: 5 })
    await transport.start()

    await waitUntil(() => log.infos.some((line) => line.includes('Nest transport:')))
    transport.stop()

    const line = log.infos.find((entry) => entry.includes('Nest transport:'))!
    // Deltas rather than cumulative totals, plus the ages and states an
    // operator would otherwise have to diff across two lines to recover.
    expect(line).toMatch(/\+\d+ Observe frame\(s\)/)
    expect(line).toMatch(/\+\d+ REST cycle\(s\)/)
    expect(line).toMatch(/last Observe .* ago/)
    expect(line).toMatch(/alarm feed (live|STALE)/)
    expect(line).toMatch(/breaker rest=\w+ obs=\w+/)
  })

  it('keeps warning while a connected Observe stream stays silent', async () => {
    // The startup warning is one-shot, so a stream healthy at 60s and dead at
    // hour five produced nothing at all — despite Observe being the only source
    // of thermostat state. Rather than waiting out the ten-minute deadline, the
    // clock is advanced once a frame has landed.
    const realNow = Date.now
    const { transport, log, http2 } = createTransport({ observeSilenceCheckMs: 5 })

    try {
      await transport.start()
      const connection = await http2.session()
      connection.push(buildFrame(heatingThermostatTraits()))
      await waitUntil(() => transport.status.observeFrames > 0)

      let offset = 0
      jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
      offset = OBSERVE_IDLE_TIMEOUT_MS + 60_000

      await waitUntil(() => log.warns.some((line) => line.includes('no frames for')))

      expect(log.warns.join('\n')).toMatch(/Observe has delivered no frames for \d+s/)
    } finally {
      jest.restoreAllMocks()
      transport.stop()
    }
  })

  it('does not treat a timed-out subscribe as proof Nest is reachable', async () => {
    // A blackholed route and a quiet house both produce a full-length client
    // timeout, so elapsed time cannot separate them. Counting silence as a
    // successful cycle refreshed the Protect alarm-feed clock and reset the
    // breaker, leaving smoke/CO tiles on a live frozen all-clear while
    // diagnostics reported healthy.
    const { transport } = createTransport()
    await transport.start()

    // start() ran app_launch, which is a real response.
    expect(transport.status.isRestAlarmFeedAvailable).toBe(true)

    const realNow = Date.now
    let offset = 0
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    try {
      // Push past the window in which a response is still recent enough to
      // vouch for the feed, without any new response arriving.
      offset = REST_RESPONSE_STALE_MS + 60_000
      expect(transport.status.isRestAlarmFeedAvailable).toBe(false)
    } finally {
      jest.restoreAllMocks()
      transport.stop()
    }
  })

  it('re-probes a transport that exhausted its HTTP 403 budget', async () => {
    // Three 403s land inside ~15s, and this codebase's own position is that a
    // 403 is most likely a WAF blip — which is sustained for minutes. Never
    // re-probing froze every thermostat (Observe) or faulted every Protect
    // (REST) until someone restarted Homebridge.
    const { fetch } = createNestFetch({ subscribeStatus: 403 })
    const { transport, log } = createTransport({ fetchImpl: fetch })
    await transport.start()

    await waitUntil(() => transport.status.restState === 'forbidden_dead')
    expect(transport.status.restState).toBe('forbidden_dead')
    expect(log.errors.join('\n')).toMatch(/giving up after 3 HTTP 403s/)
    expect(log.errors.join('\n')).toMatch(/retrying in \d+ min/)

    transport.stop()
  })

  it('brings a 403-dead transport back when the cooldown elapses', async () => {
    const { fetch } = createNestFetch({ subscribeStatus: 403 })
    const { transport, log } = createTransport({
      fetchImpl: fetch,
      forbiddenReprobeMs: 5,
    })
    await transport.start()

    await waitUntil(() => transport.status.restState === 'forbidden_dead')
    // The cooldown fires and the loop restarts rather than staying dead for the
    // lifetime of the process.
    await waitUntil(() => log.infos.some((line) => line.includes('Re-probing REST')))

    expect(log.infos.join('\n')).toMatch(/Re-probing REST after HTTP 403 cooldown/)
    transport.stop()
  })

  it('brings a 403-dead Observe stream back when the cooldown elapses', async () => {
    // Observe is the only source of thermostat state on modern accounts, so
    // leaving it dead for the process lifetime froze every thermostat.
    const { transport, http2, log } = createTransport({ forbiddenReprobeMs: 5 })
    await transport.start()

    for (let attempt = 0; attempt < FORBIDDEN_FATAL_THRESHOLD; attempt++) {
      const connection = await http2.session()
      connection.respond(403)
      await waitUntil(() => log.warns.some((line) => line.includes(`(${attempt + 1}/`)))
    }

    await waitUntil(() => log.infos.some((line) => line.includes('Re-probing Observe')))
    expect(log.infos.join('\n')).toMatch(/Re-probing Observe after HTTP 403 cooldown/)

    transport.stop()
  })

  it('reports decode degradation through status so health can see it', async () => {
    const { transport, http2, log } = createTransport()
    await transport.start()
    const connection = await http2.session()

    expect(transport.status.isDecodeDegraded).toBe(false)

    const garbage = Buffer.concat([
      Buffer.from([0x00, 0x05]),
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]),
    ])
    for (let i = 0; i < FRAME_DECODE_WINDOW + 5; i++) {
      connection.push(garbage)
    }

    // A one-shot log line scrolls away; the flag is what reaches the health
    // rollup, which is the only thing that keeps reporting the condition.
    expect(transport.status.isDecodeDegraded).toBe(true)
    expect(log.warns.join('\n')).toContain('could not be')

    // Recovery is announced and clears the flag.
    for (let i = 0; i < FRAME_DECODE_WINDOW + 5; i++) {
      connection.push(buildFrame(heatingThermostatTraits()))
    }
    expect(transport.status.isDecodeDegraded).toBe(false)
    expect(log.infos.join('\n')).toContain('decoding again')

    transport.stop()
  })

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
    expect(log.infos.join('\n')).not.toMatch(/Updating Heat/)

    transport.stop()
  })

  it('rethrows when BatchUpdateState fails (accessory logs once)', async () => {
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

    expect(log.warns.join('\n')).not.toMatch(/BatchUpdateState failed/)
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

    // The first failure of a streak warns: logging these at debug meant a
    // persistently broken transport was invisible with the default config.
    expect(log.warns.join('\n')).toContain('Observe stream failed')
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
