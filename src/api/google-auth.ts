/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Google account sign-in, producing Nest tokens on demand.
 *
 * Flow, repeated before each token expires:
 *   1. `GET` the configured issueToken URL with the account's Google cookies.
 *      Google answers with a short-lived OAuth access token.
 *   2. `POST` that token to Nest's auth proxy (`issue_jwt`), which answers with
 *      a Nest token and its expiry.
 *   3. The caller opens a Nest session with the Nest token (see `session.ts`).
 *
 * Google refreshes some of its cookies on every sign-in, the same way it does
 * in a browser. Those are merged back in and handed to a {@link CookieStore},
 * so the next sign-in, including the first one after a restart, presents what
 * Google last issued.
 */

import { ApiParseError, AuthenticationError, createApiError } from '../errors'
import {
  GOOGLE_SIGN_IN_TIMEOUT_MS,
  GOOGLE_USER_AGENT,
  NEST_ISSUE_JWT_URL,
  NEST_TOKEN_LIFETIME_SEC,
} from '../settings'
import type { Logger } from '../utils/logger'
import { previewSecret, sanitizeString, sanitizeUrl } from '../utils/sanitizers'
import { sendRequest, type FetchLike, type RawResponse } from './http'

/** A Nest token and when it stops working. */
export interface NestToken {
  readonly value: string
  /** Epoch milliseconds. */
  readonly expiresAt: number
}

/** Anything that can produce a fresh Nest token. */
export interface TokenSource {
  mintToken(signal?: AbortSignal): Promise<NestToken>
}

/** Where cookies that Google updates are kept between restarts. */
export interface CookieStore {
  /** The cookie header last saved for these configured cookies, if any. */
  load(configuredCookies: string): string | undefined
  save(configuredCookies: string, cookies: string): void
}

export interface GoogleAuthOptions {
  /** Validated issueToken URL (see `validators.ts`). */
  issueToken: string
  /** Validated `Cookie` header from the configuration. */
  cookies: string
  store?: CookieStore
  log: Logger
  fetchImpl?: FetchLike
}

/** The subset of the issueToken response the plugin reads. */
interface IssueTokenResponse {
  access_token?: unknown
  error?: unknown
}

/** The subset of the issue_jwt response the plugin reads. */
interface IssueJwtResponse {
  jwt?: unknown
  claims?: { expirationTime?: unknown }
}

/**
 * Parse a `Cookie` header into an ordered name → value map.
 *
 * Order is kept so a merged header reads the same as the browser's did.
 */
export function parseCookieHeader(header: string): Map<string, string> {
  const jar = new Map<string, string>()
  for (const pair of header.split(';')) {
    const equals = pair.indexOf('=')
    if (equals <= 0) {
      continue
    }
    const name = pair.slice(0, equals).trim()
    if (name) {
      jar.set(name, pair.slice(equals + 1).trim())
    }
  }
  return jar
}

/** Serialise a cookie map back into a `Cookie` header. */
export function formatCookieHeader(jar: ReadonlyMap<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * Apply `Set-Cookie` headers to a cookie header.
 *
 * A cookie whose value is empty, whose `Max-Age` is zero or less, or whose
 * `Expires` is in the past is removed, which is how a server deletes one.
 *
 * @returns The merged header, or the input unchanged when nothing applied.
 */
export function mergeSetCookies(header: string, setCookies: readonly string[], now = Date.now()): string {
  const jar = parseCookieHeader(header)
  let isChanged = false

  for (const setCookie of setCookies) {
    const [pair = '', ...attributes] = setCookie.split(';')
    const equals = pair.indexOf('=')
    if (equals <= 0) {
      continue
    }
    const name = pair.slice(0, equals).trim()
    const value = pair.slice(equals + 1).trim()

    const isDeleted = value === '' || attributes.some((attribute) => {
      const [key = '', raw = ''] = attribute.split('=').map((part) => part.trim())
      if (key.toLowerCase() === 'max-age') {
        return Number(raw) <= 0
      }
      if (key.toLowerCase() === 'expires') {
        const expires = Date.parse(raw)
        return Number.isFinite(expires) && expires <= now
      }
      return false
    })

    if (isDeleted) {
      isChanged = jar.delete(name) || isChanged
    } else if (jar.get(name) !== value) {
      jar.set(name, value)
      isChanged = true
    }
  }

  return isChanged ? formatCookieHeader(jar) : header
}

/** Parse a JSON body, reporting a non-JSON body as the endpoint's fault. */
function parseJson<T>(url: string, response: RawResponse): T {
  try {
    return JSON.parse(response.text) as T
  } catch (error) {
    throw new ApiParseError(
      `${sanitizeUrl(url)} returned HTTP ${response.status} with a body that is not JSON`,
      { cause: error instanceof Error ? error : undefined },
    )
  }
}

/** Signs in to the Google account and exchanges the result for Nest tokens. */
export class GoogleAuth implements TokenSource {
  readonly #options: GoogleAuthOptions
  #cookies: string

  constructor(options: GoogleAuthOptions) {
    this.#options = options
    this.#cookies = options.store?.load(options.cookies) ?? options.cookies
  }

  /**
   * Sign in and return a fresh Nest token.
   *
   * @throws {AuthenticationError} When Google rejects the cookies or Nest
   *   rejects the Google token. Signing in again would be refused too.
   */
  async mintToken(signal?: AbortSignal): Promise<NestToken> {
    const googleToken = await this.#issueGoogleToken(signal)
    const token = await this.#issueNestToken(googleToken, signal)

    if (this.#options.log.debugEnabled) {
      const minutes = Math.round((token.expiresAt - Date.now()) / 60_000)
      this.#options.log.debug(
        `Signed in with Google; Nest token ${previewSecret(token.value)} expires in ${minutes} min`,
      )
    }
    return token
  }

  async #issueGoogleToken(signal?: AbortSignal): Promise<string> {
    const url = this.#options.issueToken
    const response = await sendRequest(url, {
      method: 'GET',
      headers: {
        'User-Agent': GOOGLE_USER_AGENT,
        'Sec-Fetch-Mode': 'cors',
        'X-Requested-With': 'XmlHttpRequest',
        Referer: 'https://accounts.google.com/o/oauth2/iframe',
        cookie: this.#cookies,
      },
      timeoutMs: GOOGLE_SIGN_IN_TIMEOUT_MS,
      fetchImpl: this.#options.fetchImpl,
      signal,
    })

    this.#applySetCookies(response.headers)

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new AuthenticationError(undefined, { status: response.status })
    }
    if (response.status >= 400) {
      throw createApiError(response.status, `${sanitizeUrl(url)} returned HTTP ${response.status}`)
    }

    const body = parseJson<IssueTokenResponse>(url, response)
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      // Google answers a signed-out or expired cookie with HTTP 200 and an
      // `error` field such as "USER_LOGGED_OUT".
      const reason = typeof body.error === 'string' ? ` (${sanitizeString(body.error)})` : ''
      throw new AuthenticationError(
        `Google rejected the sign-in${reason}. Copy a new Issue Token URL and Cookies as described in docs/AUTH.md.`,
        { status: 401 },
      )
    }
    return body.access_token
  }

  async #issueNestToken(googleToken: string, signal?: AbortSignal): Promise<NestToken> {
    const response = await sendRequest(NEST_ISSUE_JWT_URL, {
      method: 'POST',
      headers: {
        'User-Agent': GOOGLE_USER_AGENT,
        Authorization: `Bearer ${googleToken}`,
        'Content-Type': 'application/json',
        Referer: 'https://home.nest.com/',
        Origin: 'https://home.nest.com',
      },
      body: JSON.stringify({
        embed_google_oauth_access_token: true,
        expire_after: `${NEST_TOKEN_LIFETIME_SEC}s`,
        google_oauth_access_token: googleToken,
        policy_id: 'authproxy-oauth-policy',
      }),
      timeoutMs: GOOGLE_SIGN_IN_TIMEOUT_MS,
      fetchImpl: this.#options.fetchImpl,
      signal,
    })

    if (response.status === 400) {
      throw new AuthenticationError(
        `Nest would not issue a token for this Google account (HTTP 400). Make sure the account is an admin of the home, then copy a new Issue Token URL and Cookies as described in docs/AUTH.md.`,
        { status: 400 },
      )
    }
    if (response.status >= 400) {
      throw createApiError(response.status, `${sanitizeUrl(NEST_ISSUE_JWT_URL)} returned HTTP ${response.status}`)
    }

    const body = parseJson<IssueJwtResponse>(NEST_ISSUE_JWT_URL, response)
    if (typeof body.jwt !== 'string' || body.jwt.length === 0) {
      throw new ApiParseError(`${sanitizeUrl(NEST_ISSUE_JWT_URL)} returned no Nest token`)
    }

    const now = Date.now()
    const stated = typeof body.claims?.expirationTime === 'string'
      ? Date.parse(body.claims.expirationTime)
      : Number.NaN
    const expiresAt = Number.isFinite(stated) && stated > now
      ? stated
      : now + NEST_TOKEN_LIFETIME_SEC * 1_000

    return { value: body.jwt, expiresAt }
  }

  #applySetCookies(headers: Headers): void {
    const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
    if (setCookies.length === 0) {
      return
    }
    const merged = mergeSetCookies(this.#cookies, setCookies)
    if (merged === this.#cookies) {
      return
    }
    this.#cookies = merged
    this.#options.store?.save(this.#options.cookies, merged)
  }
}
