/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Google sign-in and the exchange for a Nest token.
 */

import {
  GoogleAuth,
  formatCookieHeader,
  mergeSetCookies,
  parseCookieHeader,
  type CookieStore,
} from '../../../src/api/google-auth'
import type { FetchLike } from '../../../src/api/http'
import {
  ApiParseError,
  ApiResponseError,
  AuthenticationError,
  NetworkError,
  isFatalTransportError,
} from '../../../src/errors'
import { NEST_ISSUE_JWT_URL, NEST_TOKEN_LIFETIME_SEC } from '../../../src/settings'
import type { RecordedCall } from '../../helpers/fetch'
import { createRecordingLogger } from '../../helpers/logger'
import { TEST_COOKIES, TEST_ISSUE_TOKEN } from '../../helpers/sign-in'

interface Reply {
  status?: number
  body?: unknown
  setCookies?: string[]
}

const GOOGLE_OK: Reply = { body: { access_token: 'ya29.test-google-token', expires_in: 3599 } }

function nestOk(expirationTime?: string): Reply {
  return { body: { jwt: 'g.0.test-nest-token', claims: expirationTime ? { expirationTime } : {} } }
}

/** A fetch that answers issueToken and issue_jwt from scripted replies. */
function signInFetch(google: Reply[], nest: Reply[] = [nestOk()]) {
  const calls: RecordedCall[] = []
  let googleIndex = 0
  let nestIndex = 0

  const respond = (reply: Reply): Response => {
    const headers = new Headers()
    for (const cookie of reply.setCookies ?? []) {
      headers.append('set-cookie', cookie)
    }
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})
    return new Response(text, { status: reply.status ?? 200, headers })
  }

  const fetch = (async (url: unknown, options: RequestInit = {}) => {
    const target = String(url)
    calls.push({
      url: target,
      method: options.method,
      headers: (options.headers ?? {}) as Record<string, string>,
      body: options.body as string | undefined,
    })
    if (target === NEST_ISSUE_JWT_URL) {
      return respond(nest[Math.min(nestIndex++, nest.length - 1)] ?? nestOk())
    }
    return respond(google[Math.min(googleIndex++, google.length - 1)] ?? GOOGLE_OK)
  }) as unknown as FetchLike

  return { fetch, calls }
}

function memoryStore(initial?: string): CookieStore & { saved: string[] } {
  const saved: string[] = []
  return {
    saved,
    load: () => initial,
    save: (_configured, cookies) => { saved.push(cookies) },
  }
}

function createAuth(fetch: FetchLike, store?: CookieStore, debugEnabled = false) {
  const log = { ...createRecordingLogger(), debugEnabled }
  const auth = new GoogleAuth({ issueToken: TEST_ISSUE_TOKEN, cookies: TEST_COOKIES, store, log, fetchImpl: fetch })
  return { auth, log }
}

describe('GoogleAuth', () => {
  it('exchanges the cookies for a Google token and then a Nest token', async () => {
    const expirationTime = new Date(Date.now() + 45 * 60_000).toISOString()
    const { fetch, calls } = signInFetch([GOOGLE_OK], [nestOk(expirationTime)])

    const token = await createAuth(fetch).auth.mintToken()

    expect(token.value).toBe('g.0.test-nest-token')
    expect(token.expiresAt).toBe(Date.parse(expirationTime))

    expect(calls[0]?.url).toBe(TEST_ISSUE_TOKEN)
    expect(calls[0]?.headers.cookie).toBe(TEST_COOKIES)
    expect(calls[0]?.headers['X-Requested-With']).toBe('XmlHttpRequest')

    expect(calls[1]?.url).toBe(NEST_ISSUE_JWT_URL)
    expect(calls[1]?.method).toBe('POST')
    expect(calls[1]?.headers.Authorization).toBe('Bearer ya29.test-google-token')
    expect(calls[1]?.headers.cookie).toBeUndefined()
    expect(JSON.parse(String(calls[1]?.body))).toMatchObject({
      google_oauth_access_token: 'ya29.test-google-token',
      expire_after: `${NEST_TOKEN_LIFETIME_SEC}s`,
      policy_id: 'authproxy-oauth-policy',
    })
  })

  it.each([
    ['missing', undefined],
    ['unparseable', 'soon'],
    ['already past', '2000-01-01T00:00:00Z'],
  ])('assumes the requested lifetime when the stated expiry is %s', async (_label, expirationTime) => {
    const { fetch } = signInFetch([GOOGLE_OK], [nestOk(expirationTime)])
    const before = Date.now()

    const token = await createAuth(fetch).auth.mintToken()

    expect(token.expiresAt).toBeGreaterThanOrEqual(before + NEST_TOKEN_LIFETIME_SEC * 1_000)
  })

  it('treats a signed-out cookie as a rejected sign-in and names the reason', async () => {
    // Google answers this with HTTP 200 and an error field, not a 4xx.
    const { fetch, calls } = signInFetch([{ body: { error: 'USER_LOGGED_OUT' } }])

    const error = await createAuth(fetch).auth.mintToken().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthenticationError)
    expect(isFatalTransportError(error)).toBe(true)
    expect((error as Error).message).toContain('USER_LOGGED_OUT')
    expect((error as Error).message).toContain('docs/AUTH.md')
    expect(calls).toHaveLength(1)
  })

  it.each([400, 401, 403])('treats HTTP %i from issueToken as a rejected sign-in', async (status) => {
    const { fetch } = signInFetch([{ status, body: {} }])

    const error = await createAuth(fetch).auth.mintToken().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthenticationError)
    expect((error as AuthenticationError).httpStatus).toBe(status)
  })

  it('retries a Google outage instead of stopping the plugin', async () => {
    const { fetch } = signInFetch([{ status: 503, body: {} }])

    const error = await createAuth(fetch).auth.mintToken().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiResponseError)
    expect((error as ApiResponseError).isRetryable).toBe(true)
    expect(isFatalTransportError(error)).toBe(false)
  })

  it('treats HTTP 401 from the Nest auth proxy as a rejected sign-in', async () => {
    const { fetch } = signInFetch([GOOGLE_OK], [{ status: 401, body: {} }])

    await expect(createAuth(fetch).auth.mintToken()).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('treats HTTP 400 from the Nest auth proxy as a rejected sign-in that names the admin requirement', async () => {
    const { fetch } = signInFetch([GOOGLE_OK], [{ status: 400, body: {} }])

    const error = await createAuth(fetch).auth.mintToken().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AuthenticationError)
    expect(error).toMatchObject({ message: expect.stringMatching(/admin of the home/) })
  })

  it('reports a Nest auth proxy answer without a token as an unexpected response', async () => {
    const { fetch } = signInFetch([GOOGLE_OK], [{ body: { claims: {} } }])

    await expect(createAuth(fetch).auth.mintToken()).rejects.toBeInstanceOf(ApiParseError)
  })

  it('reports a body that is not JSON as an unexpected response', async () => {
    const { fetch } = signInFetch([{ body: '<html>sign in</html>' }])

    await expect(createAuth(fetch).auth.mintToken()).rejects.toBeInstanceOf(ApiParseError)
  })

  it('reports an unreachable Google as a network error', async () => {
    const fetch = (async () => {
      throw new TypeError('getaddrinfo ENOTFOUND')
    }) as unknown as FetchLike

    await expect(createAuth(fetch).auth.mintToken()).rejects.toBeInstanceOf(NetworkError)
  })

  it('sends the cookies Google updated on the next sign-in and saves them', async () => {
    const { fetch, calls } = signInFetch([
      { ...GOOGLE_OK, setCookies: ['SIDCC=rotated-sidcc; Path=/; Secure; HttpOnly', 'NID=new-nid; Path=/'] },
      GOOGLE_OK,
    ])
    const store = memoryStore()
    const { auth } = createAuth(fetch, store)

    await auth.mintToken()
    await auth.mintToken()

    const expected = 'SID=test-sid; HSID=test-hsid; SIDCC=rotated-sidcc; NID=new-nid'
    expect(calls[2]?.headers.cookie).toBe(expected)
    expect(store.saved).toEqual([expected])
  })

  it('does not save when Google sends back the same cookies', async () => {
    const { fetch } = signInFetch([{ ...GOOGLE_OK, setCookies: ['SIDCC=test-sidcc; Path=/'] }])
    const store = memoryStore()

    await createAuth(fetch, store).auth.mintToken()

    expect(store.saved).toEqual([])
  })

  it('starts from the saved cookies after a restart', async () => {
    const { fetch, calls } = signInFetch([GOOGLE_OK])
    const store = memoryStore('SID=test-sid; SIDCC=saved-sidcc')

    await createAuth(fetch, store).auth.mintToken()

    expect(calls[0]?.headers.cookie).toBe('SID=test-sid; SIDCC=saved-sidcc')
  })

  it('never writes a credential to the log', async () => {
    const { fetch } = signInFetch([GOOGLE_OK])
    const { auth, log } = createAuth(fetch, undefined, true)

    await auth.mintToken()

    expect(log.all()).not.toContain('test-sid')
    expect(log.all()).not.toContain('ya29.test-google-token')
    expect(log.all()).not.toContain('g.0.test-nest-token')
    expect(log.debugs.join('\n')).toContain('Signed in with Google')
  })
})

describe('cookie headers', () => {
  it('parses and formats a header without changing its order', () => {
    const header = 'SID=a; HSID=b=c; NID=d'

    expect([...parseCookieHeader(header)]).toEqual([['SID', 'a'], ['HSID', 'b=c'], ['NID', 'd']])
    expect(formatCookieHeader(parseCookieHeader(header))).toBe(header)
  })

  it('skips fragments that are not name=value pairs', () => {
    expect([...parseCookieHeader('SID=a; junk; =b; ')]).toEqual([['SID', 'a']])
  })

  it('replaces an updated cookie in place and appends a new one', () => {
    expect(mergeSetCookies('SID=a; NID=b', ['NID=c; Path=/', 'OTZ=d'])).toBe('SID=a; NID=c; OTZ=d')
  })

  it.each([
    ['an empty value', 'NID=; Path=/'],
    ['Max-Age=0', 'NID=gone; Max-Age=0'],
    ['an Expires in the past', 'NID=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
  ])('removes a cookie deleted with %s', (_label, setCookie) => {
    expect(mergeSetCookies('SID=a; NID=b', [setCookie])).toBe('SID=a')
  })

  it('keeps a cookie whose Expires is in the future', () => {
    const now = Date.parse('2030-01-01T00:00:00Z')

    expect(mergeSetCookies('SID=a', ['NID=b; Expires=Wed, 01 Jan 2031 00:00:00 GMT'], now)).toBe('SID=a; NID=b')
  })

  it('returns the header unchanged when nothing applies', () => {
    const header = 'SID=a;NID=b'

    expect(mergeSetCookies(header, ['SID=a', 'not-a-cookie'])).toBe(header)
  })
})
