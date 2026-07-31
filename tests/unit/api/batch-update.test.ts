/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest TraitBatchApi/BatchUpdateState HTTP client.
 */

import { postBatchUpdateState } from '../../../src/api/batch-update'
import { ForbiddenError } from '../../../src/errors'
import { resolveEndpoints } from '../../../src/settings'
import type { NestSession } from '../../../src/types/nest'
import { textFetch } from '../../helpers/fetch'

const endpoints = resolveEndpoints(false)

const session: NestSession = {
  token: 'session-token',
  userId: '555',
  transportUrl: 'https://czfe123.transport.home.nest.com',
  openedAt: Date.now(),
}

describe('postBatchUpdateState', () => {
  it('POSTs protobuf bytes to TraitBatchApi/BatchUpdateState', async () => {
    const body = Buffer.from([0x0a, 0x01, 0x00])
    const { fetch, calls } = textFetch('', { status: 200 })

    await postBatchUpdateState({ session, endpoints, body, fetchImpl: fetch })

    expect(calls).toHaveLength(1)
    expect(String(calls[0].url)).toContain('/nestlabs.gateway.v1.TraitBatchApi/BatchUpdateState')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers).toMatchObject({
      Authorization: 'Basic session-token',
      'Content-Type': 'application/x-protobuf',
    })
    expect(calls[0].body).toBe(body)
  })

  it('throws on HTTP 403', async () => {
    const { fetch } = textFetch('no', { status: 403 })

    await expect(postBatchUpdateState({
      session,
      endpoints,
      body: Buffer.from('x'),
      fetchImpl: fetch,
    })).rejects.toBeInstanceOf(ForbiddenError)
  })
})
