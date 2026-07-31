/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview POST Nest TraitBatchApi/BatchUpdateState.
 */

import { randomUUID } from 'node:crypto'
import { USER_AGENT, WEB_APP_VERSION, type NestEndpoints } from '../settings'
import { createApiError, parseRetryAfterMs } from '../errors'
import type { NestSession } from '../types/nest'
import { sanitizeUrl } from '../utils/sanitizers'
import { sendRequest, type FetchLike } from './http'

export interface BatchUpdateOptions {
  session: NestSession
  endpoints: NestEndpoints
  /** Encoded `nest.rpc.NestMessage` body. */
  body: Buffer
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: FetchLike
}

/**
 * Send one BatchUpdateState request.
 *
 * The response body is protobuf (often empty-ish on success); callers care
 * about HTTP status, not a decoded payload.
 */
export async function postBatchUpdateState(options: BatchUpdateOptions): Promise<void> {
  const url = `${options.endpoints.grpcOrigin}${options.endpoints.batchUpdatePath}`
  const response = await sendRequest(url, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Authorization: `Basic ${options.session.token}`,
      'Content-Type': 'application/x-protobuf',
      'X-Accept-Content-Transfer-Encoding': 'binary',
      'X-Accept-Response-Streaming': 'true',
      'request-id': randomUUID(),
      referer: `https://${options.endpoints.apiHostname}/`,
      origin: `https://${options.endpoints.apiHostname}`,
      'x-nl-webapp-version': WEB_APP_VERSION,
    },
    body: options.body,
    timeoutMs: options.timeoutMs ?? 30_000,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  })

  if (response.status >= 400) {
    throw createApiError(
      response.status,
      `${sanitizeUrl(url)} returned HTTP ${response.status}`,
      { retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')) },
    )
  }
}
