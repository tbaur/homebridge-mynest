/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared HTTP plumbing for the Nest REST endpoints.
 *
 * The one subtlety here is abort handling. The REST `subscribe` call is a long
 * poll that the *client* is expected to end, so "the request was aborted" is
 * both the normal idle outcome and the shutdown signal, and the two must be
 * told apart. {@link sendRequest} therefore reports which of its own deadlines
 * fired instead of collapsing everything into one `AbortError`.
 */

import { ApiParseError, NetworkError, TimeoutError, createApiError, isAbortError, parseRetryAfterMs } from '../errors'
import { sanitizeUrl } from '../utils/sanitizers'

/** Node's global `fetch`, or a substitute supplied by tests. */
export type FetchLike = typeof globalThis.fetch

export interface SendOptions {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  /** JSON string for REST, or raw protobuf bytes for BatchUpdateState. */
  body?: string | Buffer | Uint8Array
  /** Client-side deadline. Never omitted: no Nest call may wait forever. */
  timeoutMs: number
  /** Caller-owned abort, used for shutdown. Distinct from the timeout. */
  signal?: AbortSignal
  fetchImpl?: FetchLike
}

/** A completed HTTP exchange, before any status interpretation. */
export interface RawResponse {
  readonly status: number
  readonly headers: Headers
  readonly text: string
}

/**
 * Perform an HTTP request with a client-side deadline.
 *
 * @throws {TimeoutError} When {@link SendOptions.timeoutMs} elapsed first.
 * @throws {NetworkError} On transport failure.
 * @throws The caller's abort error unchanged when {@link SendOptions.signal}
 *   fired, so a shutdown is never mistaken for a timeout.
 */
export async function sendRequest(url: string, options: SendOptions): Promise<RawResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new NetworkError('global fetch is unavailable; Node 20 or newer is required')
  }

  // `addEventListener('abort')` does not fire for a signal that is already
  // aborted, so a shutdown that raced past the loop's isStopped check would
  // otherwise hold a live fetch for the full timeout (up to 120s for subscribe).
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error('The request was aborted')
  }

  const controller = new AbortController()
  let didTimeout = false

  const timer = setTimeout(() => {
    didTimeout = true
    controller.abort()
  }, options.timeoutMs)

  const forwardAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', forwardAbort, { once: true })

  try {
    const response = await fetchImpl(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    })
    const text = await response.text()
    return { status: response.status, headers: response.headers, text }
  } catch (error) {
    if (options.signal?.aborted) {
      throw error
    }
    if (didTimeout || isAbortError(error)) {
      throw new TimeoutError(
        `${sanitizeUrl(url)} did not respond within ${options.timeoutMs}ms`,
        { cause: error instanceof Error ? error : undefined },
      )
    }
    throw new NetworkError(
      `Could not reach ${sanitizeUrl(url)}`,
      { cause: error instanceof Error ? error : undefined },
    )
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}

/**
 * Perform a request and parse a JSON response.
 *
 * The body is read and parsed before the status is checked, because Nest puts
 * its most useful diagnostics in the body of a failed response.
 *
 * @throws {ApiParseError} When the body is not JSON. Nest serves an HTML error
 *   page from its edge when a request is refused before it reaches the API,
 *   and reporting that as a JSON syntax error hides what happened.
 */
export async function requestJson<T>(url: string, options: SendOptions): Promise<T> {
  const response = await sendRequest(url, options)

  if (response.status >= 400) {
    throw createApiError(
      response.status,
      `${sanitizeUrl(url)} returned HTTP ${response.status}`,
      { retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')) },
    )
  }

  try {
    return JSON.parse(response.text) as T
  } catch (error) {
    throw new ApiParseError(
      `${sanitizeUrl(url)} returned HTTP ${response.status} with a body that is not JSON`,
      { cause: error instanceof Error ? error : undefined },
    )
  }
}
