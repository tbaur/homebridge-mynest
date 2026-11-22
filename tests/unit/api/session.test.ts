/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Opening a Nest session with a Nest token.
 */

import { authenticatedHeaders, openSession } from '../../../src/api/session'
import {
  AuthenticationError,
  NestError,
  SessionShapeError,
  isFatalTransportError,
} from '../../../src/errors'
import { resolveEndpoints } from '../../../src/settings'
import { createRecordingLogger } from '../../helpers/logger'
import { jsonFetch } from '../../helpers/fetch'

const endpoints = resolveEndpoints(false)

const validSession = {
  access_token: 'session-token-value',
  userid: '5551234',
  urls: { transport_url: 'https://czfe123-front01-iad01.transport.home.nest.com' },
}

const TOKEN_EXPIRES_AT = Date.now() + 60 * 60_000

function nestToken(value = 'nest-token') {
  return { value, expiresAt: TOKEN_EXPIRES_AT }
}

function open(body: unknown, tokenValue = 'nest-token') {
  const log = createRecordingLogger()
  const { fetch, calls } = jsonFetch(body)
  return { log, calls, promise: openSession({ token: nestToken(tokenValue), endpoints, log, fetchImpl: fetch }) }
}

describe('openSession', () => {
  it('returns the token, user id, and transport URL Nest issued', async () => {
    const session = await open(validSession).promise

    expect(session.token).toBe('session-token-value')
    expect(session.userId).toBe('5551234')
    expect(session.transportUrl).toBe('https://czfe123-front01-iad01.transport.home.nest.com')
    expect(session.openedAt).toBeGreaterThan(0)
  })

  it('sends the Nest token as Basic auth and no cookies', async () => {
    const { calls, promise } = open(validSession, 'my-nest-token')
    await promise

    expect(calls[0].url).toBe(endpoints.sessionUrl)
    expect(calls[0].headers.Authorization).toBe('Basic my-nest-token')
    expect(calls[0].headers.cookie).toBeUndefined()
  })

  it('accepts a numeric user id, which Nest sometimes returns', async () => {
    const session = await open({ ...validSession, userid: 5551234 }).promise

    expect(session.userId).toBe('5551234')
  })

  it('trims a trailing slash so the subscribe path is not doubled', async () => {
    const session = await open({
      ...validSession,
      urls: { transport_url: 'https://czfe123.transport.home.nest.com/' },
    }).promise

    expect(session.transportUrl).toBe('https://czfe123.transport.home.nest.com')
  })

  it('names every field a malformed response is missing', async () => {
    const error = await open({ access_token: 'only-this' }).promise.catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SessionShapeError)
    expect((error as Error).message).toContain('userid')
    expect((error as Error).message).toContain('urls.transport_url')
  })

  it('refuses a transport host that is not Nest', async () => {
    // `transport_url` is server-controlled and the session token is sent to it
    // on every poll, so a response alone must not be able to redirect a live
    // credential somewhere else.
    const error = await open({
      ...validSession,
      urls: { transport_url: 'https://attacker.example.com' },
    }).promise.catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SessionShapeError)
    expect((error as Error).message).toContain('attacker.example.com')
    expect((error as Error).message).not.toMatch(/paste/i)
  })

  it.each([
    ['a non-default port', 'https://sub.nest.com:31337'],
    ['embedded credentials', 'https://user:pass@sub.nest.com'],
    ['plain http', 'http://sub.nest.com'],
    ['a lookalike host', 'https://evilnest.com'],
  ])('refuses a transport URL with %s', async (_label, transportUrl) => {
    // Port and userinfo are part of where the credential actually goes; a
    // hostname-only check passes all of these while the live session token
    // ends up somewhere it should not.
    const error = await open({
      ...validSession,
      urls: { transport_url: transportUrl },
    }).promise.catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SessionShapeError)
  })

  it('expires with the Nest token, not with the session response', async () => {
    // `/session` reports `expires_in` as a far-off date string that has
    // nothing to do with when the Nest token stops working.
    const session = await open({ ...validSession, expires_in: 'Tue, 01-Jan-2036 00:00:00 GMT' }).promise

    expect(session.expiresAt).toBe(TOKEN_EXPIRES_AT)
  })

  it('refuses a plaintext transport URL', async () => {
    await expect(open({
      ...validSession,
      urls: { transport_url: 'http://czfe123.transport.home.nest.com' },
    }).promise).rejects.toThrow(SessionShapeError)
  })

  it('refuses a transport URL that will not parse', async () => {
    await expect(open({
      ...validSession,
      urls: { transport_url: 'not a url' },
    }).promise).rejects.toThrow(SessionShapeError)
  })

  it('accepts Nest\'s other production domain', async () => {
    const session = await open({
      ...validSession,
      urls: { transport_url: 'https://czfe123.transport.nestlabs.com' },
    }).promise

    expect(session.transportUrl).toContain('nestlabs.com')
  })

  it.each([400, 401])('treats HTTP %i from the session endpoint as a rejected Nest token', async (status) => {
    const { fetch } = jsonFetch(
      { error: 'invalid_request', error_description: 'missing user credentials' },
      { status },
    )
    const error = await openSession({
      token: nestToken(),
      endpoints,
      log: createRecordingLogger(),
      fetchImpl: fetch,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthenticationError)
    expect((error as AuthenticationError).httpStatus).toBe(status)
  })

  it.each([403, 404, 408, 429, 499, 503])('retries on HTTP %i instead of stopping the plugin', async (status) => {
    const { fetch } = jsonFetch({}, { status })
    const error = await openSession({
      token: nestToken(),
      endpoints,
      log: createRecordingLogger(),
      fetchImpl: fetch,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(NestError)
    expect(isFatalTransportError(error)).toBe(false)
  })

  it('never writes a token to the log', async () => {
    const { log, promise } = open(validSession, 'super-secret-nest-token')
    await promise

    expect(log.all()).not.toContain('super-secret-nest-token')
    expect(log.all()).not.toContain('session-token-value')
  })
})

describe('authenticatedHeaders', () => {
  it('carries the session token and user id Nest requires', () => {
    const headers = authenticatedHeaders({
      token: 'abc',
      userId: '42',
      transportUrl: 'https://x.transport.home.nest.com',
      openedAt: 0,
      expiresAt: 0,
    })

    expect(headers.Authorization).toBe('Basic abc')
    expect(headers['X-nl-user-id']).toBe('42')
    expect(headers['X-nl-protocol-version']).toBe('1')
  })
})
