/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest session, opened with a Nest token from Google sign-in.
 *
 * Flow:
 *   1. `GET /session` with `Authorization: Basic <Nest token>` (see
 *      `google-auth.ts` for where the token comes from).
 *   2. Use the `access_token`, `userid`, and `urls.transport_url` from that
 *      response for every subsequent REST and Observe call, until the Nest
 *      token expires.
 */

import { AuthenticationError, SessionShapeError, isSessionTokenRejection } from '../errors'
import {
  SESSION_TIMEOUT_MS,
  USER_AGENT,
  type NestEndpoints,
} from '../settings'
import type { NestSession } from '../types/nest'
import type { Logger } from '../utils/logger'
import type { NestToken } from './google-auth'
import { requestJson, type FetchLike } from './http'

/** The subset of `GET /session` the plugin reads. */
interface SessionResponse {
  access_token?: unknown
  userid?: unknown
  urls?: { transport_url?: unknown }
}

export interface OpenSessionOptions {
  /** A freshly minted Nest token. */
  token: NestToken
  endpoints: NestEndpoints
  log: Logger
  fetchImpl?: FetchLike
  signal?: AbortSignal
}

/** Build the headers Nest expects on a session request. */
function sessionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Basic ${token}`,
    'User-Agent': USER_AGENT,
  }
}

/** Standard headers for an authenticated REST call, once a session exists. */
export function authenticatedHeaders(session: NestSession): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Authorization: `Basic ${session.token}`,
    'X-nl-user-id': session.userId,
    'X-nl-protocol-version': '1',
    'Content-Type': 'application/json',
  }
}

/**
 * Fetch `GET /session`, reporting HTTP 400 or 401 as a rejected token.
 *
 * @throws {AuthenticationError} On HTTP 400 or 401.
 */
async function requestSession(options: OpenSessionOptions): Promise<SessionResponse> {
  try {
    return await requestJson<SessionResponse>(options.endpoints.sessionUrl, {
      method: 'GET',
      headers: sessionHeaders(options.token.value),
      timeoutMs: SESSION_TIMEOUT_MS,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    })
  } catch (error) {
    if (!isSessionTokenRejection(error) || error instanceof AuthenticationError) {
      throw error
    }
    throw new AuthenticationError(error.message, { cause: error, status: error.httpStatus })
  }
}

/**
 * Exchange a Nest token for a usable session.
 *
 * @throws {AuthenticationError} When Nest rejects the token (HTTP 400 or 401).
 * @throws {SessionShapeError} When the response is accepted but omits a field
 *   the plugin needs, or names a transport host off Nest infrastructure. Either
 *   means Nest changed the contract; signing in again would not help.
 */
export async function openSession(options: OpenSessionOptions): Promise<NestSession> {
  const { log } = options

  const body = await requestSession(options)

  const token = typeof body.access_token === 'string' ? body.access_token : undefined
  // Only a scalar. `String()` accepts anything, so an object would become
  // `'[object Object]'` — truthy, so it passes the missing-field check below and
  // then goes into the app_launch URL, sending the live token to a path Nest
  // will 404. A shape change should raise SessionShapeError, which exists to say
  // "Nest changed its session format; please report this".
  const userId = typeof body.userid === 'string' || typeof body.userid === 'number'
    ? String(body.userid)
    : undefined
  const transportUrl = typeof body.urls?.transport_url === 'string'
    ? body.urls.transport_url
    : undefined

  const missing: string[] = []
  if (!token) {
    missing.push('access_token')
  }
  if (!userId) {
    missing.push('userid')
  }
  if (!transportUrl) {
    missing.push('urls.transport_url')
  }
  if (missing.length > 0) {
    throw new SessionShapeError(missing)
  }

  // A session whose transport host is not a Nest host would send the token
  // wherever the response says. The value is server-controlled, so it is
  // checked rather than trusted — and the *normalized* form is what gets used,
  // because a query or fragment on the raw string would turn the subscribe path
  // into query data and silently POST to `/` instead.
  const normalizedTransportUrl = assertNestTransportUrl(transportUrl!)

  log.debug('Nest session established')

  return {
    token: token!,
    userId: userId!,
    transportUrl: normalizedTransportUrl,
    openedAt: Date.now(),
    expiresAt: options.token.expiresAt,
  }
}

/** Hosts the session token may be sent to, beyond the fixed API endpoints. */
const ALLOWED_TRANSPORT_SUFFIXES = ['.nest.com', '.nestlabs.com'] as const

/**
 * Refuse a transport URL that would send the token off Nest's infrastructure.
 *
 * `transport_url` comes from the session response and is appended to on every
 * subscribe, so without this check the server response alone decides where a
 * live credential is delivered.
 *
 * @returns The normalized `origin + pathname` form, with any query, fragment,
 *   and trailing slash removed, so callers cannot append a path onto something
 *   that is not a path.
 */
function assertNestTransportUrl(transportUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(transportUrl)
  } catch {
    throw new SessionShapeError('has a transport URL that is not a valid URL, so it was refused')
  }

  const isHttps = parsed.protocol === 'https:'
  const isNestHost = ALLOWED_TRANSPORT_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix))
  // Port and userinfo are part of where the credential actually goes. A
  // response naming `https://user:pass@sub.nest.com:31337` passes a
  // hostname-only check while redirecting the live session token elsewhere.
  const isDefaultPort = parsed.port === '' || parsed.port === '443'
  const hasUserInfo = parsed.username !== '' || parsed.password !== ''

  if (!isHttps || !isNestHost || !isDefaultPort || hasUserInfo) {
    throw new SessionShapeError(
      `names an unexpected transport host (${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}), so the session token was not sent to it`,
    )
  }

  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
}
