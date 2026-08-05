/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest Account session, the only authentication path supported.
 *
 * Flow:
 *   1. `GET /session` with `Authorization: Basic <configured access_token>`.
 *   2. Use the `access_token`, `userid`, and `urls.transport_url` from that
 *      response for every subsequent REST and Observe call.
 *
 * Google account sign-in is deliberately not implemented. It requires
 * replaying a browser cookie through Google's own `issueToken` flow, which
 * Google changes without notice and which asks the user to paste a credential
 * covering their entire Google account rather than just their Nest home.
 */

import { AuthenticationError, SessionShapeError } from '../errors'
import {
  SESSION_TIMEOUT_MS,
  USER_AGENT,
  type NestEndpoints,
} from '../settings'
import type { NestSession } from '../types/nest'
import type { Logger } from '../utils/logger'
import { previewSecret } from '../utils/sanitizers'
import { requestJson, type FetchLike } from './http'

/** The subset of `GET /session` the plugin reads. */
interface SessionResponse {
  access_token?: unknown
  userid?: unknown
  expires_in?: unknown
  urls?: { transport_url?: unknown }
}

export interface OpenSessionOptions {
  /** The token from the user's config, not from a previous session. */
  accessToken: string
  endpoints: NestEndpoints
  log: Logger
  fetchImpl?: FetchLike
  signal?: AbortSignal
}

/**
 * Build the headers Nest expects on a session request.
 *
 * The token is sent twice, as Basic auth and as the `cztoken` cookie, because
 * that is what the Nest web app does and the endpoint is its private backend.
 * Sending only one of the two is not reliably accepted.
 */
function sessionHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Basic ${accessToken}`,
    'User-Agent': USER_AGENT,
    cookie: `G_ENABLED_IDPS=google; eu_cookie_accepted=1; viewer-volume=0.5; cztoken=${accessToken}`,
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
 * Exchange the configured access token for a usable session.
 *
 * @throws {AuthenticationError} When Nest rejects the token.
 * @throws {SessionShapeError} When the response is accepted but omits a field
 *   the plugin needs, which means Nest changed the contract.
 */
export async function openSession(options: OpenSessionOptions): Promise<NestSession> {
  const { accessToken, endpoints, log } = options

  if (log.debugEnabled) {
    log.debug(`Opening a Nest session with the configured token ${previewSecret(accessToken)}`)
  }

  const body = await requestJson<SessionResponse>(endpoints.sessionUrl, {
    method: 'GET',
    headers: sessionHeaders(accessToken),
    timeoutMs: SESSION_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  })

  const token = typeof body.access_token === 'string' ? body.access_token : undefined
  const userId = body.userid === undefined || body.userid === null
    ? undefined
    : String(body.userid)
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
  // checked rather than trusted.
  assertNestTransportUrl(transportUrl!)

  const expiresInSec = typeof body.expires_in === 'number'
    && Number.isFinite(body.expires_in)
    && body.expires_in > 0
    ? body.expires_in
    : undefined

  if (log.debugEnabled) {
    log.debug(
      `Nest session established; the session token is ${previewSecret(token)}`
      + `${expiresInSec !== undefined ? ` and expires in ${expiresInSec}s` : ''}`,
    )
  }

  const openedAt = Date.now()
  return {
    token: token!,
    userId: userId!,
    transportUrl: transportUrl!.replace(/\/+$/, ''),
    openedAt,
    expiresAt: expiresInSec !== undefined ? openedAt + expiresInSec * 1_000 : undefined,
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
 */
function assertNestTransportUrl(transportUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(transportUrl)
  } catch {
    throw new AuthenticationError(
      'The Nest session returned a transport URL that is not a valid URL; refusing to use it.',
    )
  }

  const isHttps = parsed.protocol === 'https:'
  const isNestHost = ALLOWED_TRANSPORT_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix))
  // Port and userinfo are part of where the credential actually goes. A
  // response naming `https://user:pass@sub.nest.com:31337` passes a
  // hostname-only check while redirecting the live session token elsewhere.
  const isDefaultPort = parsed.port === '' || parsed.port === '443'
  const hasUserInfo = parsed.username !== '' || parsed.password !== ''

  if (!isHttps || !isNestHost || !isDefaultPort || hasUserInfo) {
    throw new AuthenticationError(
      `The Nest session returned an unexpected transport host (${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}); refusing to send the session token to it.`,
    )
  }
}
