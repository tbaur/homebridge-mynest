/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview One connection to Nest's Observe stream.
 *
 * Observe is an HTTP/2 POST whose response never ends: Nest sends a full trait
 * snapshot and then streams patches for as long as the connection lives. This
 * module owns exactly one such connection and always resolves with why it
 * finished, so the reconnect policy can live somewhere testable rather than
 * being tangled up with socket handling.
 *
 * The failure that matters here is not a dropped connection — that is obvious
 * and easy to recover from. It is a connection that stays open and stops
 * delivering, which is indistinguishable from a quiet house and leaves HomeKit
 * showing yesterday's temperature forever. That is what the idle deadline is
 * for.
 */

import { randomUUID } from 'node:crypto'
import http2 from 'node:http2'
import {
  OBSERVE_IDLE_TIMEOUT_MS,
  OBSERVE_PING_INTERVAL_MS,
  OBSERVE_SESSION_MS,
  USER_AGENT,
  WEB_APP_VERSION,
  type NestEndpoints,
} from '../settings'
import { AuthenticationError, ForbiddenError, ObserveStreamError } from '../errors'
import type { NestSession } from '../types/nest'
import type { Logger } from '../utils/logger'
import { FrameSplitter } from './framing'
import { readObserveTraitsRequest } from './protobuf'

/** Why an Observe connection finished. */
export type ObserveEndReason =
  /** The scheduled recycle deadline was reached; the stream was healthy. */
  | 'recycled'
  /** Nothing arrived within the idle deadline; the stream had gone silent. */
  | 'idle'
  /** Nest closed the response. */
  | 'ended'
  /** The caller asked to stop. */
  | 'aborted'

export interface ObserveSessionResult {
  readonly reason: ObserveEndReason
  readonly frameCount: number
  readonly durationMs: number
}

/** Node's `http2.connect`, or a substitute supplied by tests. */
export type Http2Connect = typeof http2.connect

export interface ObserveSessionOptions {
  session: NestSession
  endpoints: NestEndpoints
  log: Logger
  /** Called for each complete frame, in order. */
  onFrame: (frame: Buffer) => void
  /** Shutdown signal. Aborting resolves the session rather than rejecting it. */
  signal?: AbortSignal
  connect?: Http2Connect
  /** Overridable for tests; production uses the module constants. */
  sessionMs?: number
  idleTimeoutMs?: number
  pingIntervalMs?: number
}

/**
 * Headers the Nest gateway requires on an Observe request.
 *
 * `X-Accept-Response-Streaming` is what asks for the long-lived stream rather
 * than a single snapshot, and the referer/origin pair is checked: the gateway
 * is the Nest web app's private backend and rejects callers that do not look
 * like it.
 */
function observeHeaders(session: NestSession, endpoints: NestEndpoints): http2.OutgoingHttpHeaders {
  return {
    ':method': 'POST',
    ':path': endpoints.observePath,
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/x-protobuf',
    'X-Accept-Content-Transfer-Encoding': 'binary',
    'X-Accept-Response-Streaming': 'true',
    Authorization: `Basic ${session.token}`,
    'request-id': randomUUID(),
    // Must match the configured Nest environment. Field-test gRPC rejects a
    // production origin/referer the same way production rejects an FT one.
    referer: `https://${endpoints.apiHostname}/`,
    origin: `https://${endpoints.apiHostname}`,
    'x-nl-webapp-version': WEB_APP_VERSION,
  }
}

/**
 * Open one Observe connection and pump frames until it ends.
 *
 * @returns Why the connection finished, for the caller's reconnect policy.
 * @throws {ObserveStreamError} On a transport or protocol failure.
 */
export function runObserveSession(options: ObserveSessionOptions): Promise<ObserveSessionResult> {
  const connect = options.connect ?? http2.connect
  const sessionMs = options.sessionMs ?? OBSERVE_SESSION_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? OBSERVE_IDLE_TIMEOUT_MS
  const pingIntervalMs = options.pingIntervalMs ?? OBSERVE_PING_INTERVAL_MS

  const traitsRequest = readObserveTraitsRequest()
  const startedAt = Date.now()

  return new Promise<ObserveSessionResult>((resolve, reject) => {
    const splitter = new FrameSplitter()
    let frameCount = 0
    let isSettled = false

    const client = connect(options.endpoints.grpcOrigin, { maxOutstandingPings: 2 })
    const request = client.request(observeHeaders(options.session, options.endpoints))

    const timers: NodeJS.Timeout[] = []
    let idleTimer: NodeJS.Timeout | undefined

    /**
     * Tear everything down exactly once.
     *
     * Every path out of this function goes through here — success, failure,
     * abort, and each deadline — because an Observe connection that is not
     * closed keeps a socket, a ping interval, and a 300 KB frame buffer alive
     * for the lifetime of the Homebridge process.
     */
    const settle = (outcome: { reason: ObserveEndReason } | { error: Error }): void => {
      if (isSettled) {
        return
      }
      isSettled = true

      for (const timer of timers) {
        clearTimeout(timer)
        clearInterval(timer)
      }
      if (idleTimer) {
        clearTimeout(idleTimer)
      }
      options.signal?.removeEventListener('abort', onAbort)

      request.close()
      client.close()

      if ('error' in outcome) {
        reject(outcome.error)
        return
      }
      resolve({
        reason: outcome.reason,
        frameCount,
        durationMs: Date.now() - startedAt,
      })
    }

    const onAbort = (): void => settle({ reason: 'aborted' })

    const resetIdleTimer = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer)
      }
      idleTimer = setTimeout(() => settle({ reason: 'idle' }), idleTimeoutMs)
      // The idle deadline must not be a reason to keep Node alive; Homebridge
      // owns the process lifetime.
      idleTimer.unref?.()
    }

    timers.push(setTimeout(() => settle({ reason: 'recycled' }), sessionMs))
    timers.push(setInterval(() => {
      // Nest drops a stream it believes is dead. Failing to ping is not itself
      // fatal — the idle deadline is the real backstop — so a rejected ping is
      // swallowed rather than tearing down a working connection.
      try {
        client.ping(() => undefined)
      } catch {
        /* the idle deadline will catch a genuinely dead stream */
      }
    }, pingIntervalMs))

    for (const timer of timers) {
      timer.unref?.()
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })

    // HTTP/2 emits `response` then `end` with no `error` for 401/403/5xx, so
    // without this handler a rejected token looks like Nest recycling a healthy
    // stream (reason `ended`, frameCount 0) and the loop reconnects forever.
    request.on('response', (headers: NodeJS.Dict<string | string[] | undefined>) => {
      const status = Number(headers[':status'])
      if (!Number.isFinite(status) || status < 400) {
        return
      }
      if (status === 401) {
        settle({
          error: new AuthenticationError(
            `Observe gateway returned HTTP ${status}`,
          ),
        })
        return
      }
      if (status === 403) {
        settle({
          error: new ForbiddenError(`Observe gateway returned HTTP ${status}`),
        })
        return
      }
      settle({
        error: new ObserveStreamError(`Observe gateway returned HTTP ${status}`),
      })
    })

    request.on('data', (chunk: Buffer) => {
      resetIdleTimer()

      let frames: Buffer[]
      try {
        frames = splitter.push(chunk)
      } catch (error) {
        settle({
          error: new ObserveStreamError(
            `Could not parse the Observe stream: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error instanceof Error ? error : undefined },
          ),
        })
        return
      }

      for (const frame of frames) {
        frameCount++
        try {
          options.onFrame(frame)
        } catch (error) {
          // A consumer that throws must not kill the transport; the next frame
          // is very likely fine and dropping the stream costs live updates.
          options.log.debug(
            `Observe frame handler threw: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    })

    request.on('end', () => settle({ reason: 'ended' }))
    request.on('error', (error) => settle({
      error: new ObserveStreamError(`Observe stream failed: ${error.message}`, { cause: error }),
    }))
    client.on('error', (error) => settle({
      error: new ObserveStreamError(`Observe connection failed: ${error.message}`, { cause: error }),
    }))
    client.on('close', () => settle({ reason: 'ended' }))

    resetIdleTimer()
    request.end(traitsRequest)
  })
}
