/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A scriptable stand-in for an HTTP/2 client session.
 *
 * The Observe client is given its `connect` function, so tests drive the stream
 * directly — emitting chunks at chosen boundaries, ending it, or failing it —
 * without a server or a socket.
 */

import { EventEmitter } from 'node:events'
import type { Http2Connect } from '../../src/api/observe'

class FakeStream extends EventEmitter {
  readonly writes: Buffer[] = []
  isClosed = false

  end(body?: Buffer): void {
    if (body) {
      this.writes.push(body)
    }
  }

  close(): void {
    this.isClosed = true
  }
}

export class FakeHttp2Session extends EventEmitter {
  readonly stream = new FakeStream()
  requestHeaders: Record<string, unknown> = {}
  isClosed = false
  destroyed = false
  pingCount = 0
  /** Set to make `ping` throw, as a dead session does. */
  shouldFailPing = false
  /** Set to make `request` throw, as a session already in GOAWAY does. */
  shouldFailRequest = false

  request(headers: Record<string, unknown>): FakeStream {
    if (this.shouldFailRequest) {
      throw new Error('ERR_HTTP2_GOAWAY_SESSION')
    }
    this.requestHeaders = headers
    return this.stream
  }

  ping(callback: () => void): void {
    if (this.shouldFailPing) {
      throw new Error('session destroyed')
    }
    this.pingCount++
    callback()
  }

  close(): void {
    if (this.isClosed) {
      return
    }
    this.isClosed = true
    // A real Http2Session emits `close` once it finishes closing, which is what
    // the client relies on to cancel its forced-destroy backstop.
    this.emit('close')
  }

  /**
   * Force the session down.
   *
   * `close()` is graceful and may never complete on a half-dead socket, so the
   * Observe client follows it with a `destroy()` after a grace period.
   */
  destroy(): void {
    this.destroyed = true
    this.isClosed = true
  }

  // --- test controls -------------------------------------------------------

  /** Deliver a chunk of response body. */
  push(chunk: Buffer): void {
    this.stream.emit('data', chunk)
  }

  /** Deliver a buffer in fixed-size pieces, as a real socket would. */
  pushInChunks(buffer: Buffer, chunkSize: number): void {
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      this.push(buffer.subarray(offset, offset + chunkSize))
    }
  }

  /** Emit HTTP/2 response headers (including `:status`). */
  respond(status: number, headers: Record<string, string> = {}): void {
    this.stream.emit('response', { ':status': status, ...headers })
  }

  /** End the response cleanly, as Nest does when it recycles a stream. */
  end(): void {
    this.stream.emit('end')
  }

  failStream(message = 'stream reset'): void {
    this.stream.emit('error', new Error(message))
  }

  failSession(message = 'connection lost'): void {
    this.emit('error', new Error(message))
  }
}

export interface FakeHttp2 {
  connect: Http2Connect
  /** Resolves once the client has opened a connection. */
  session(): Promise<FakeHttp2Session>
  origins: string[]
}

/** Build a `connect` that hands out {@link FakeHttp2Session} instances. */
export function createFakeHttp2(): FakeHttp2 {
  const origins: string[] = []
  let current: FakeHttp2Session | undefined
  let notify: ((session: FakeHttp2Session) => void) | undefined

  const connect = ((origin: string) => {
    origins.push(origin)
    current = new FakeHttp2Session()
    notify?.(current)
    return current
  }) as unknown as Http2Connect

  return {
    connect,
    origins,
    session: () => current
      ? Promise.resolve(current)
      : new Promise<FakeHttp2Session>((resolve) => {
        notify = resolve
      }),
  }
}
