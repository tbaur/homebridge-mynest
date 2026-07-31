/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview One Observe connection, and every way it can end.
 *
 * The failure worth testing hardest is not a dropped connection — that is
 * obvious and easy to recover from — but a connection that stays open and stops
 * delivering, which leaves HomeKit showing yesterday's temperature forever.
 */

import { runObserveSession } from '../../../src/api/observe'
import { AuthenticationError, ForbiddenError, ObserveStreamError } from '../../../src/errors'
import { resolveEndpoints } from '../../../src/settings'
import type { NestSession } from '../../../src/types/nest'
import { createFakeHttp2 } from '../../helpers/http2'
import { createRecordingLogger } from '../../helpers/logger'
import { buildFrame, heatingThermostatTraits } from '../../helpers/observe-fixtures'

const endpoints = resolveEndpoints(false)
const session: NestSession = {
  token: 'session-token',
  userId: '5551234',
  transportUrl: 'https://czfe123.transport.home.nest.com',
  openedAt: Date.now(),
}

function start(overrides: Partial<Parameters<typeof runObserveSession>[0]> = {}) {
  const http2 = createFakeHttp2()
  const log = createRecordingLogger()
  const frames: Buffer[] = []

  const promise = runObserveSession({
    session,
    endpoints,
    log,
    connect: http2.connect,
    onFrame: (frame) => frames.push(frame),
    sessionMs: 10_000,
    idleTimeoutMs: 10_000,
    pingIntervalMs: 10_000,
    ...overrides,
  })

  return { http2, log, frames, promise }
}

describe('runObserveSession', () => {
  it('connects to the gRPC gateway with the headers Nest requires', async () => {
    const { http2, promise } = start()
    const connection = await http2.session()

    expect(http2.origins).toEqual([endpoints.grpcOrigin])
    expect(connection.requestHeaders[':path']).toBe(endpoints.observePath)
    expect(connection.requestHeaders[':method']).toBe('POST')
    expect(connection.requestHeaders.Authorization).toBe('Basic session-token')
    // Without this header Nest answers with one snapshot and closes.
    expect(connection.requestHeaders['X-Accept-Response-Streaming']).toBe('true')
    expect(connection.requestHeaders.origin).toBe('https://home.nest.com')
    expect(connection.requestHeaders.referer).toBe('https://home.nest.com/')

    connection.end()
    await promise
  })

  it('uses field-test origin and referer when pointed at FT endpoints', async () => {
    const ft = resolveEndpoints(true)
    const { http2, promise } = start({ endpoints: ft })
    const connection = await http2.session()

    expect(http2.origins).toEqual([ft.grpcOrigin])
    expect(connection.requestHeaders.origin).toBe('https://home.ft.nest.com')
    expect(connection.requestHeaders.referer).toBe('https://home.ft.nest.com/')

    connection.end()
    await promise
  })

  it('sends the trait subscription body', async () => {
    const { http2, promise } = start()
    const connection = await http2.session()

    expect(connection.stream.writes).toHaveLength(1)
    expect(connection.stream.writes[0].length).toBeGreaterThan(0)

    connection.end()
    await promise
  })

  it('reports each complete frame in order', async () => {
    const { http2, frames, promise } = start()
    const connection = await http2.session()

    const first = buildFrame(heatingThermostatTraits('DEVICE_ONE'))
    const second = buildFrame(heatingThermostatTraits('DEVICE_TWO'))
    connection.push(Buffer.concat([first, second]))
    connection.end()

    const result = await promise

    expect(frames).toHaveLength(2)
    expect(frames[0].equals(first)).toBe(true)
    expect(result.frameCount).toBe(2)
  })

  it('reassembles a frame delivered a few bytes at a time', async () => {
    const { http2, frames, promise } = start()
    const connection = await http2.session()

    const frame = buildFrame(heatingThermostatTraits())
    connection.pushInChunks(frame, 3)
    connection.end()
    await promise

    expect(frames).toHaveLength(1)
    expect(frames[0].equals(frame)).toBe(true)
  })

  it('ends when Nest closes the stream', async () => {
    const { http2, promise } = start()
    const connection = await http2.session()
    connection.end()

    await expect(promise).resolves.toMatchObject({ reason: 'ended' })
  })

  it('recycles the connection on its own schedule', async () => {
    // Nest drops these streams whenever it likes, so the plugin gets ahead of it
    // and reconnects on a cadence it controls.
    const { promise } = start({ sessionMs: 20 })

    await expect(promise).resolves.toMatchObject({ reason: 'recycled' })
  })

  it('gives up on a stream that has gone silent', async () => {
    // The socket is fine and no error is raised; the stream has simply stopped
    // delivering. Without this deadline the plugin would sit on it forever.
    const { promise } = start({ idleTimeoutMs: 20, sessionMs: 10_000 })

    await expect(promise).resolves.toMatchObject({ reason: 'idle' })
  })

  it('restarts the idle deadline whenever data arrives', async () => {
    const { http2, promise } = start({ idleTimeoutMs: 60, sessionMs: 200 })
    const connection = await http2.session()

    const frame = buildFrame(heatingThermostatTraits())
    const keepAlive = setInterval(() => connection.push(frame), 20)

    const result = await promise
    clearInterval(keepAlive)

    expect(result.reason).toBe('recycled')
    expect(result.frameCount).toBeGreaterThan(1)
  })

  it('reports a stream failure as an Observe error', async () => {
    const { http2, promise } = start()
    const connection = await http2.session()
    connection.failStream('stream reset by peer')

    await expect(promise).rejects.toThrow(ObserveStreamError)
  })

  it('reports a connection failure as an Observe error', async () => {
    const { http2, promise } = start()
    const connection = await http2.session()
    connection.failSession()

    await expect(promise).rejects.toThrow(ObserveStreamError)
  })

  it('resolves rather than throwing when asked to shut down', async () => {
    const controller = new AbortController()
    const { http2, promise } = start({ signal: controller.signal })
    await http2.session()

    controller.abort()

    await expect(promise).resolves.toMatchObject({ reason: 'aborted' })
  })

  it('closes the stream and connection however it ends', async () => {
    const { http2, promise } = start()
    const connection = await http2.session()
    connection.end()
    await promise

    // An Observe connection left open keeps a socket, a ping interval, and a
    // frame buffer alive for the life of the Homebridge process.
    expect(connection.stream.isClosed).toBe(true)
    expect(connection.isClosed).toBe(true)
  })

  it('cleans up after a failure too', async () => {
    const { http2, promise } = start()
    const connection = await http2.session()
    connection.failStream()
    await promise.catch(() => undefined)

    expect(connection.isClosed).toBe(true)
  })

  it('keeps the stream alive with pings', async () => {
    const { http2, promise } = start({ pingIntervalMs: 15, sessionMs: 80 })
    const connection = await http2.session()

    await promise

    expect(connection.pingCount).toBeGreaterThan(1)
  })

  it('survives a ping that throws, leaving the idle deadline to decide', async () => {
    const { http2, promise } = start({ pingIntervalMs: 10, sessionMs: 60 })
    const connection = await http2.session()
    connection.shouldFailPing = true

    await expect(promise).resolves.toMatchObject({ reason: 'recycled' })
  })

  it('keeps going when a frame handler throws', async () => {
    // One bad trait mapping must not cost the whole stream; the next frame is
    // very likely fine.
    const { http2, log, promise } = start({
      onFrame: () => {
        throw new Error('handler exploded')
      },
    })
    const connection = await http2.session()

    connection.push(buildFrame(heatingThermostatTraits()))
    connection.end()
    const result = await promise

    expect(result.frameCount).toBe(1)
    expect(log.debugs.join('\n')).toContain('handler exploded')
  })

  it('fails cleanly when the stream sends unusable framing', async () => {
    const { http2, promise } = start()
    const connection = await http2.session()

    // A length prefix declaring a frame far beyond the ceiling.
    connection.push(Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0x7f]))

    await expect(promise).rejects.toThrow(ObserveStreamError)
  })

  it('treats an HTTP 401 response as authentication failure', async () => {
    const { http2, promise } = start()
    const connection = await http2.session()
    connection.respond(401)
    await expect(promise).rejects.toThrow(AuthenticationError)
  })

  it('treats an HTTP 403 response as forbidden (retryable)', async () => {
    const { http2, promise } = start()
    const connection = await http2.session()
    connection.respond(403)
    await expect(promise).rejects.toThrow(ForbiddenError)
  })

  it('treats an HTTP 503 response as a retryable stream error', async () => {
    const { http2, promise } = start()
    const connection = await http2.session()
    connection.respond(503)
    await expect(promise).rejects.toThrow(ObserveStreamError)
  })

  it('reports how long it ran', async () => {
    const { promise } = start({ sessionMs: 30 })

    await expect(promise).resolves.toMatchObject({ durationMs: expect.any(Number) })
  })
})
