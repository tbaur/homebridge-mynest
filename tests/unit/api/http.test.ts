/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview HTTP plumbing, especially telling a timeout from a shutdown.
 *
 * The REST subscribe call is a long poll the client ends itself, so "aborted"
 * is both the ordinary idle outcome and the shutdown signal. Collapsing the two
 * would either fill the log with fake errors or keep the plugin polling through
 * shutdown.
 */

import { requestJson, sendRequest } from '../../../src/api/http'
import {
  ApiParseError,
  AuthenticationError,
  ForbiddenError,
  NetworkError,
  RateLimitError,
  TimeoutError,
} from '../../../src/errors'
import { MAX_RESPONSE_BYTES } from '../../../src/settings'
import { failingFetch, hangingFetch, jsonFetch, textFetch } from '../../helpers/fetch'

const URL_UNDER_TEST = 'https://home.nest.com/session'

describe('sendRequest', () => {
  it('rejects immediately when the caller signal is already aborted', async () => {
    const { fetch, calls } = textFetch('should-not-run')
    const controller = new AbortController()
    controller.abort()

    await expect(sendRequest(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 60_000,
      signal: controller.signal,
      fetchImpl: fetch,
    })).rejects.toThrow(/aborted/i)

    expect(calls).toHaveLength(0)
  })

  it('refuses a body that declares more than the size ceiling', async () => {
    // `app_launch` returns the whole account, so bodies are legitimately large
    // — but reading one without a ceiling lets a malfunctioning or hostile
    // endpoint exhaust memory and take down every plugin in the process.
    const { fetch } = textFetch('small body', {
      headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
    })

    await expect(sendRequest(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 60_000,
      fetchImpl: fetch,
    })).rejects.toThrow(ApiParseError)
  })

  it('accepts a body that declares a size within the ceiling', async () => {
    const { fetch } = textFetch('ok', { headers: { 'content-length': '2' } })

    await expect(sendRequest(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 60_000,
      fetchImpl: fetch,
    })).resolves.toMatchObject({ status: 200, text: 'ok' })
  })

  it('returns the status, headers, and body', async () => {
    const { fetch } = textFetch('hello', { status: 201, headers: { 'x-test': 'yes' } })

    const response = await sendRequest(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      fetchImpl: fetch,
    })

    expect(response.status).toBe(201)
    expect(response.text).toBe('hello')
    expect(response.headers.get('x-test')).toBe('yes')
  })

  it('passes the method, headers, and body through', async () => {
    const { fetch, calls } = textFetch('{}')

    await sendRequest(URL_UNDER_TEST, {
      method: 'POST',
      headers: { Authorization: 'Basic secret' },
      body: '{"a":1}',
      timeoutMs: 1000,
      fetchImpl: fetch,
    })

    expect(calls[0]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Basic secret' },
      body: '{"a":1}',
    })
  })

  it('raises a timeout when its own deadline elapses', async () => {
    const { fetch } = hangingFetch()

    await expect(sendRequest(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 10,
      fetchImpl: fetch,
    })).rejects.toThrow(TimeoutError)
  })

  it('re-throws the caller abort untouched on shutdown', async () => {
    // The subscribe loop tells the idle case from shutdown by type alone, so
    // this must not arrive wrapped as a TimeoutError.
    const { fetch } = hangingFetch()
    const controller = new AbortController()

    const pending = sendRequest(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 60_000,
      fetchImpl: fetch,
      signal: controller.signal,
    })

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(pending).rejects.not.toBeInstanceOf(TimeoutError)
  })

  it('reports a transport failure as a network error', async () => {
    const { fetch } = failingFetch()

    await expect(sendRequest(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      fetchImpl: fetch,
    })).rejects.toThrow(NetworkError)
  })

  it('explains itself on a Node old enough to lack fetch', async () => {
    const original = globalThis.fetch
    delete (globalThis as { fetch?: unknown }).fetch

    try {
      await expect(sendRequest(URL_UNDER_TEST, {
        method: 'GET',
        headers: {},
        timeoutMs: 1000,
      })).rejects.toThrow(/Node 22/)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('requestJson', () => {
  it('parses a successful response', async () => {
    const { fetch } = jsonFetch({ userid: '123' })

    await expect(requestJson(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      fetchImpl: fetch,
    })).resolves.toEqual({ userid: '123' })
  })

  it('maps an authentication failure to a fatal error', async () => {
    const { fetch } = jsonFetch({}, { status: 401 })

    await expect(requestJson(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      fetchImpl: fetch,
    })).rejects.toThrow(AuthenticationError)
  })

  it('carries the server\'s retry delay on a rate limit', async () => {
    const { fetch } = jsonFetch({}, { status: 429, headers: { 'retry-after': '30' } })

    await expect(requestJson(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      fetchImpl: fetch,
    })).rejects.toMatchObject({ retryAfterMs: 30_000 })
  })

  it('reports an HTML error page as a parse failure, not a syntax error', async () => {
    // Nest serves HTML from its edge when a request is refused before reaching
    // the API. "Unexpected token <" tells the user nothing.
    const { fetch } = textFetch('<html>Access denied</html>')

    const error = await requestJson(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      fetchImpl: fetch,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiParseError)
    expect((error as Error).message).toContain('not JSON')
  })

  it('does not leak the URL query string into the error', async () => {
    const { fetch } = jsonFetch({}, { status: 500 })

    const error = await requestJson(`${URL_UNDER_TEST}?token=supersecret`, {
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      fetchImpl: fetch,
    }).catch((caught: unknown) => caught)

    expect((error as Error).message).not.toContain('supersecret')
  })

  it('treats a rate limit and a 403 as retryable, and a 401 as not', async () => {
    const rateLimited = await requestJson(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      fetchImpl: jsonFetch({}, { status: 429 }).fetch,
    }).catch((caught: unknown) => caught)

    const forbidden = await requestJson(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      fetchImpl: jsonFetch({}, { status: 403 }).fetch,
    }).catch((caught: unknown) => caught)

    const unauthorized = await requestJson(URL_UNDER_TEST, {
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      fetchImpl: jsonFetch({}, { status: 401 }).fetch,
    }).catch((caught: unknown) => caught)

    expect(rateLimited).toBeInstanceOf(RateLimitError)
    expect((rateLimited as RateLimitError).isRetryable).toBe(true)
    expect(forbidden).toBeInstanceOf(ForbiddenError)
    expect((forbidden as ForbiddenError).isRetryable).toBe(true)
    expect(unauthorized).toBeInstanceOf(AuthenticationError)
    expect((unauthorized as AuthenticationError).isRetryable).toBe(false)
  })
})
