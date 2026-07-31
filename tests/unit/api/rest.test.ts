/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview `app_launch`, the subscribe long-poll, and the object list.
 *
 * The revisions the object list tracks are what make the long-poll work: send
 * a stale one and Nest returns immediately, turning the poll into a busy loop
 * against the account's rate limit.
 */

import { ObjectList, appLaunch, subscribeOnce } from '../../../src/api/rest'
import { ApiParseError, AuthenticationError } from '../../../src/errors'
import { APP_LAUNCH_BUCKET_TYPES, resolveEndpoints } from '../../../src/settings'
import type { NestObject, NestSession } from '../../../src/types/nest'
import { hangingFetch, jsonFetch, textFetch } from '../../helpers/fetch'

const endpoints = resolveEndpoints(false)
const session: NestSession = {
  token: 'session-token',
  userId: '5551234',
  transportUrl: 'https://czfe123.transport.home.nest.com',
  openedAt: Date.now(),
}

const topaz: NestObject = {
  object_key: 'topaz.ABC123',
  object_revision: 7,
  object_timestamp: 1700000000,
  value: { smoke_status: 0 },
}

describe('appLaunch', () => {
  it('returns the buckets Nest reported', async () => {
    const { fetch } = jsonFetch({ updated_buckets: [topaz] })

    const objects = await appLaunch({
      session,
      endpoints,
      bucketTypes: APP_LAUNCH_BUCKET_TYPES,
      fetchImpl: fetch,
    })

    expect(objects).toEqual([topaz])
  })

  it('asks for every bucket type the plugin understands', async () => {
    const { fetch, calls } = jsonFetch({ updated_buckets: [] })

    await appLaunch({ session, endpoints, bucketTypes: APP_LAUNCH_BUCKET_TYPES, fetchImpl: fetch })

    expect(JSON.parse(String(calls[0].body)).known_bucket_types).toEqual([...APP_LAUNCH_BUCKET_TYPES])
    expect(calls[0].url).toContain('/user/5551234/app_launch')
  })

  it('accepts the `objects` spelling Nest uses on some responses', async () => {
    const { fetch } = jsonFetch({ objects: [topaz] })

    await expect(appLaunch({ session, endpoints, bucketTypes: [], fetchImpl: fetch }))
      .resolves.toEqual([topaz])
  })

  it('drops entries with no object key rather than failing the whole read', async () => {
    const { fetch } = jsonFetch({ updated_buckets: [topaz, { value: {} }, null] })

    await expect(appLaunch({ session, endpoints, bucketTypes: [], fetchImpl: fetch }))
      .resolves.toEqual([topaz])
  })

  it('surfaces a rejected token', async () => {
    const { fetch } = jsonFetch({}, { status: 401 })

    await expect(appLaunch({ session, endpoints, bucketTypes: [], fetchImpl: fetch }))
      .rejects.toThrow(AuthenticationError)
  })
})

describe('subscribeOnce', () => {
  it('returns the objects that changed', async () => {
    const { fetch } = jsonFetch({ objects: [topaz] })

    const result = await subscribeOnce({ session, endpoints, objects: [], fetchImpl: fetch })

    expect(result.isIdle).toBe(false)
    expect(result.objects).toEqual([topaz])
  })

  it('echoes back only the identifiers, never the values', async () => {
    // Sending whole bucket contents makes the request enormous on a large home
    // and changes nothing about what Nest returns.
    const { fetch, calls } = jsonFetch({ objects: [] })

    await subscribeOnce({ session, endpoints, objects: [topaz], fetchImpl: fetch })

    expect(JSON.parse(String(calls[0].body)).objects).toEqual([
      { object_key: 'topaz.ABC123', object_revision: 7, object_timestamp: 1700000000 },
    ])
  })

  it('posts to the account\'s own transport host', async () => {
    const { fetch, calls } = jsonFetch({ objects: [] })

    await subscribeOnce({ session, endpoints, objects: [], fetchImpl: fetch })

    expect(calls[0].url).toBe('https://czfe123.transport.home.nest.com/v5/subscribe')
  })

  it('treats its own deadline as idle, not as a failure', async () => {
    // On a quiet house this is the normal outcome of every poll. Logging it as
    // an error would fill the log with failures when nothing is wrong.
    const { fetch } = hangingFetch()

    const result = await subscribeOnce({ session, endpoints, objects: [], timeoutMs: 10, fetchImpl: fetch })

    expect(result).toEqual({ isIdle: true, objects: [] })
  })

  it('treats a server-side long-poll expiry as idle', async () => {
    for (const status of [502, 504]) {
      const { fetch } = textFetch('', { status })

      await expect(subscribeOnce({ session, endpoints, objects: [], fetchImpl: fetch }))
        .resolves.toEqual({ isIdle: true, objects: [] })
    }
  })

  it('reports an empty result as idle', async () => {
    const { fetch } = jsonFetch({ objects: [] })

    await expect(subscribeOnce({ session, endpoints, objects: [], fetchImpl: fetch }))
      .resolves.toMatchObject({ isIdle: true })
  })

  it('propagates a shutdown instead of reporting it as idle', async () => {
    const { fetch } = hangingFetch()
    const controller = new AbortController()

    const pending = subscribeOnce({
      session,
      endpoints,
      objects: [],
      timeoutMs: 60_000,
      fetchImpl: fetch,
      signal: controller.signal,
    })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('raises a real HTTP failure', async () => {
    const { fetch } = textFetch('nope', { status: 500 })

    await expect(subscribeOnce({ session, endpoints, objects: [], fetchImpl: fetch })).rejects.toThrow()
  })

  it('reports an unparseable body as a parse error', async () => {
    const { fetch } = textFetch('<html>error</html>')

    await expect(subscribeOnce({ session, endpoints, objects: [], fetchImpl: fetch }))
      .rejects.toThrow(ApiParseError)
  })
})

describe('ObjectList', () => {
  const gone: NestObject = {
    object_key: 'topaz.GONE',
    object_revision: 1,
    object_timestamp: 1,
    value: { smoke_status: 0 },
  }

  it('applyAppLaunchSnapshot drops objects only after two consecutive omissions', () => {
    const list = new ObjectList()
    list.merge([topaz, gone])

    const first = list.applyAppLaunchSnapshot([topaz])
    expect(first.dropped).toEqual([])
    expect(first.truncated).toBe(false)
    expect(list.size).toBe(2)

    const second = list.applyAppLaunchSnapshot([topaz])
    expect(second.dropped).toEqual(['topaz.GONE'])
    expect(list.size).toBe(1)
    expect(list.toBuckets().topaz).toEqual({ ABC123: { smoke_status: 0 } })
  })

  it('treats a half-size app_launch as truncated and keeps prior objects', () => {
    const list = new ObjectList()
    list.merge([
      topaz,
      gone,
      {
        object_key: 'topaz.KEEP2',
        object_revision: 1,
        object_timestamp: 1,
        value: { smoke_status: 0 },
      },
    ])

    // 1 of 3 is less than half — Nest blip, not a home that lost two Protects.
    const result = list.applyAppLaunchSnapshot([topaz])
    expect(result.truncated).toBe(true)
    expect(result.dropped).toEqual([])
    expect(list.size).toBe(3)
  })

  it('treats an empty app_launch as truncated when objects were known', () => {
    const list = new ObjectList()
    list.merge([topaz, gone])

    const result = list.applyAppLaunchSnapshot([])
    expect(result.truncated).toBe(true)
    expect(list.size).toBe(2)
  })

  it('clears a removal candidate when a later complete snapshot names the object', () => {
    const list = new ObjectList()
    list.merge([topaz, gone])
    list.applyAppLaunchSnapshot([topaz])
    expect(list.size).toBe(2)

    list.applyAppLaunchSnapshot([topaz, gone])
    const again = list.applyAppLaunchSnapshot([topaz])
    expect(again.dropped).toEqual([])
    expect(list.size).toBe(2)
  })

  it('replace drops objects Nest no longer returns immediately', () => {
    const list = new ObjectList()
    list.merge([topaz, gone])
    list.replace([topaz])

    expect(list.size).toBe(1)
    expect(list.toBuckets().topaz).toEqual({ ABC123: { smoke_status: 0 } })
  })

  it('replaces an object with its newer revision', () => {
    const list = new ObjectList()
    list.merge([topaz])
    list.merge([{ ...topaz, object_revision: 8, value: { smoke_status: 1 } }])

    expect(list.size).toBe(1)
    expect(list.objects[0].object_revision).toBe(8)
  })

  it('ignores an update with no object key', () => {
    const list = new ObjectList()
    list.merge([{ object_key: '' }, topaz])

    expect(list.size).toBe(1)
  })

  it('indexes buckets by type and id', () => {
    const list = new ObjectList()
    list.merge([topaz])

    expect(list.toBuckets()).toEqual({ topaz: { ABC123: { smoke_status: 0 } } })
  })

  it('splits on the first dot only, so dotted ids survive', () => {
    // Protect serials contain no dots but structure and where ids do, and
    // splitting on every dot silently drops those buckets.
    const list = new ObjectList()
    list.merge([{ object_key: 'where.structure.0001', value: { wheres: [] } }])

    expect(list.toBuckets()).toEqual({ where: { 'structure.0001': { wheres: [] } } })
  })

  it('skips a malformed object key rather than creating a nameless bucket', () => {
    const list = new ObjectList()
    list.merge([{ object_key: 'nodot' }, { object_key: '.leading' }, { object_key: 'trailing.' }])

    expect(list.toBuckets()).toEqual({})
  })

  it('represents a bucket with no value as null rather than dropping it', () => {
    const list = new ObjectList()
    list.merge([{ object_key: 'topaz.ABC123' }])

    expect(list.toBuckets()).toEqual({ topaz: { ABC123: null } })
  })
})
