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
import { MAX_RESPONSE_BYTES } from '../settings'
import { sanitizeString, sanitizeUrl } from '../utils/sanitizers'

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
    throw new NetworkError('global fetch is unavailable; Node 22 or newer is required')
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
  // Every other timer in src/ is unref'd. Always cleared in `finally`, so this
  // is not a leak — but during shutdown an in-flight fetch would otherwise hold
  // the event loop open for its full budget, up to two minutes for subscribe.
  timer.unref?.()

  const forwardAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', forwardAbort, { once: true })

  try {
    const response = await fetchImpl(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
      // None of these five Nest endpoints legitimately redirects, and the
      // default would chase up to twenty hops to arbitrary hosts and then parse
      // whatever came back as a session or bucket response. A redirect here is
      // a signal something is wrong, so surface it instead of following it.
      redirect: 'error',
    })

    const text = await readBoundedText(response, url)
    return { status: response.status, headers: response.headers, text }
  } catch (error) {
    if (error instanceof ApiParseError) {
      throw error
    }
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
 * Read a response body, refusing to buffer more than the ceiling.
 *
 * Enforced *while* reading, not after. `app_launch` returns the whole account so
 * bodies are legitimately large, but a declared `content-length` is the only
 * thing a post-hoc check can act on — and a chunked response, which is what a
 * streaming edge or a hostile endpoint sends, has none. Awaiting `.text()` first
 * means the memory is already committed by the time any limit is examined, so a
 * large enough body takes down every plugin sharing the Homebridge process.
 *
 * Counts bytes rather than `String.length`: the latter counts UTF-16 code units,
 * so a multi-byte body could exceed a "byte limit" by up to threefold.
 */
async function readBoundedText(response: Response, url: string): Promise<string> {
  const tooLarge = (): ApiParseError => new ApiParseError(
    `${sanitizeUrl(url)} returned more than the ${MAX_RESPONSE_BYTES} byte limit`,
  )

  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ApiParseError(
      `${sanitizeUrl(url)} announced ${declared} bytes, beyond the ${MAX_RESPONSE_BYTES} byte limit`,
    )
  }

  const body = response.body
  if (!body) {
    // No stream to meter (an empty body, or a test double). Fall back to the
    // buffered read and check the real byte length.
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw tooLarge()
    }
    return text
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || value === undefined) {
        break
      }
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        throw tooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

/** Longest excerpt of a failure body included in an error message. */
const MAX_ERROR_BODY_CHARS = 200

/** Render a bounded, redacted excerpt of a failure body for an error message. */
function describeBody(text: string): string {
  const collapsed = sanitizeString(text).replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) {
    return ''
  }
  const excerpt = collapsed.length > MAX_ERROR_BODY_CHARS
    ? `${collapsed.slice(0, MAX_ERROR_BODY_CHARS)}…`
    : collapsed
  return `: ${excerpt}`
}

/**
 * Perform a request and parse a JSON response.
 *
 * The status is checked first, but the body is not discarded: it is excerpted
 * into the error, because Nest puts its most useful diagnostics there.
 *
 * @throws {ApiParseError} When the body is not JSON. Nest serves an HTML error
 *   page from its edge when a request is refused before it reaches the API,
 *   and reporting that as a JSON syntax error hides what happened.
 */
export async function requestJson<T>(url: string, options: SendOptions): Promise<T> {
  const response = await sendRequest(url, options)

  if (response.status >= 400) {
    // The body is included because Nest puts its only useful diagnostics there
    // and this API is undocumented — reporting a bare status code threw away
    // information that was already in memory one frame away. Bounded and
    // redacted: the scoped logger sanitizes it again, but an error message can
    // also surface outside the logger.
    throw createApiError(
      response.status,
      `${sanitizeUrl(url)} returned HTTP ${response.status}${describeBody(response.text)}`,
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
