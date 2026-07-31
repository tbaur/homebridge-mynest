/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A scripted `fetch` for transport tests.
 *
 * Injecting a fetch rather than intercepting the network keeps timeout and
 * abort behaviour under the test's control, which is what most of these tests
 * are actually about.
 */

import type { FetchLike } from '../../src/api/http'

export interface RecordedCall {
  url: string
  method?: string
  headers: Record<string, string>
  body?: string
}

export interface ScriptedFetch {
  fetch: FetchLike
  calls: RecordedCall[]
}

/** Build a `fetch` that returns the given JSON body with the given status. */
export function jsonFetch(body: unknown, init: { status?: number, headers?: Record<string, string> } = {}): ScriptedFetch {
  return textFetch(JSON.stringify(body), init)
}

/** Build a `fetch` returning a raw body, for malformed-response tests. */
export function textFetch(
  text: string,
  init: { status?: number, headers?: Record<string, string> } = {},
): ScriptedFetch {
  const calls: RecordedCall[] = []

  const fetch = (async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method,
      headers: (options.headers ?? {}) as Record<string, string>,
      body: options.body as string | undefined,
    })

    return new Response(text, {
      status: init.status ?? 200,
      headers: init.headers,
    })
  }) as unknown as FetchLike

  return { fetch, calls }
}

/** Build a `fetch` that never resolves until the request is aborted. */
export function hangingFetch(): ScriptedFetch {
  const calls: RecordedCall[] = []

  const fetch = (async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method,
      headers: (options.headers ?? {}) as Record<string, string>,
      body: options.body as string | undefined,
    })

    return new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  }) as unknown as FetchLike

  return { fetch, calls }
}

/** Build a `fetch` that fails the way an unreachable host does. */
export function failingFetch(message = 'getaddrinfo ENOTFOUND'): ScriptedFetch {
  const calls: RecordedCall[] = []

  const fetch = (async (url: unknown) => {
    calls.push({ url: String(url), headers: {} })
    throw new TypeError(message)
  }) as unknown as FetchLike

  return { fetch, calls }
}
