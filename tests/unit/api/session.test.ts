/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Opening a Nest Account session.
 */

import { authenticatedHeaders, openSession } from '../../../src/api/session'
import { AuthenticationError, SessionShapeError } from '../../../src/errors'
import { resolveEndpoints } from '../../../src/settings'
import { createRecordingLogger } from '../../helpers/logger'
import { jsonFetch } from '../../helpers/fetch'

const endpoints = resolveEndpoints(false)

const validSession = {
  access_token: 'session-token-value',
  userid: '5551234',
  expires_in: 3600,
  urls: { transport_url: 'https://czfe123-front01-iad01.transport.home.nest.com' },
}

function open(body: unknown, accessToken = 'config-token') {
  const log = createRecordingLogger()
  const { fetch, calls } = jsonFetch(body)
  return { log, calls, promise: openSession({ accessToken, endpoints, log, fetchImpl: fetch }) }
}

describe('openSession', () => {
  it('returns the token, user id, and transport URL Nest issued', async () => {
    const session = await open(validSession).promise

    expect(session.token).toBe('session-token-value')
    expect(session.userId).toBe('5551234')
    expect(session.transportUrl).toBe('https://czfe123-front01-iad01.transport.home.nest.com')
    expect(session.openedAt).toBeGreaterThan(0)
  })

  it('sends the configured token as Basic auth and as the cookie Nest expects', async () => {
    const { calls, promise } = open(validSession, 'my-config-token')
    await promise

    expect(calls[0].url).toBe(endpoints.sessionUrl)
    expect(calls[0].headers.Authorization).toBe('Basic my-config-token')
    expect(calls[0].headers.cookie).toContain('cztoken=my-config-token')
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

    expect(error).toBeInstanceOf(AuthenticationError)
    expect((error as Error).message).toContain('attacker.example.com')
  })

  it('refuses a plaintext transport URL', async () => {
    await expect(open({
      ...validSession,
      urls: { transport_url: 'http://czfe123.transport.home.nest.com' },
    }).promise).rejects.toThrow(AuthenticationError)
  })

  it('refuses a transport URL that will not parse', async () => {
    await expect(open({
      ...validSession,
      urls: { transport_url: 'not a url' },
    }).promise).rejects.toThrow(AuthenticationError)
  })

  it('accepts Nest\'s other production domain', async () => {
    const session = await open({
      ...validSession,
      urls: { transport_url: 'https://czfe123.transport.nestlabs.com' },
    }).promise

    expect(session.transportUrl).toContain('nestlabs.com')
  })

  it('never writes a token to the log', async () => {
    const { log, promise } = open(validSession, 'super-secret-config-token')
    await promise

    expect(log.all()).not.toContain('super-secret-config-token')
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
    })

    expect(headers.Authorization).toBe('Basic abc')
    expect(headers['X-nl-user-id']).toBe('42')
    expect(headers['X-nl-protocol-version']).toBe('1')
  })
})
