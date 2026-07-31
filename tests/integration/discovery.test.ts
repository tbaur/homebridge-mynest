/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview End-to-end discovery against mocked Nest transports.
 *
 * Exercises session → app_launch → Observe frames → merged inventory without
 * Homebridge, so packaging and mapping bugs show up before a Home app install.
 */

import { NestTransport } from '../../src/api/transport'
import { resolveEndpoints } from '../../src/settings'
import type { FetchLike } from '../../src/api/http'
import type { BucketMap } from '../../src/types/nest'
import type { TraitUpdate } from '../../src/api/protobuf'
import { ObserveState } from '../../src/state/observe-state'
import { buildInventory, listDevices } from '../../src/state/registry'
import { createFakeHttp2 } from '../helpers/http2'
import { createRecordingLogger } from '../helpers/logger'
import { buildFrame, heatingThermostatTraits, protectTraits } from '../helpers/observe-fixtures'

jest.mock('../../src/utils/retry', () => {
  const actual = jest.requireActual<typeof import('../../src/utils/retry')>(
    '../../src/utils/retry',
  )
  return { ...actual, sleep: jest.fn(() => Promise.resolve()) }
})

const endpoints = resolveEndpoints(false)

describe('discovery integration', () => {
  it('merges REST Protects with Observe thermostats into one inventory', async () => {
    const http2 = createFakeHttp2()
    const log = createRecordingLogger()
    const traitBatches: TraitUpdate[][] = []
    const bucketMaps: BucketMap[] = []

    const fetch = (async (url: unknown, init: RequestInit = {}) => {
      const target = String(url)
      if (target.includes('/session')) {
        return new Response(JSON.stringify({
          access_token: 'session-token',
          userid: '5551234',
          urls: { transport_url: 'https://czfe123.transport.home.nest.com' },
        }))
      }
      if (target.includes('app_launch')) {
        return new Response(JSON.stringify({
          updated_buckets: [{
            object_key: 'topaz.PROTECT01',
            object_revision: 1,
            object_timestamp: 1,
            value: {
              serial_number: 'PROTECT01',
              smoke_status: 0,
              co_status: 0,
              line_power_present: true,
              auto_away: false,
              description: 'Hall Protect',
            },
          }],
        }))
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    }) as unknown as FetchLike

    const transport = new NestTransport({
      accessToken: 'b'.repeat(120),
      endpoints,
      log,
      fetchImpl: fetch,
      connect: http2.connect,
      onTraits: (traits) => traitBatches.push([...traits]),
      onBuckets: (buckets) => bucketMaps.push(buckets),
      onFatal: () => undefined,
    })

    await transport.start()
    expect(bucketMaps.length).toBeGreaterThanOrEqual(1)

    const connection = await http2.session()
    connection.push(buildFrame([
      ...heatingThermostatTraits('DEVICE_THERM0001'),
      ...protectTraits('DEVICE_PROTECT01'),
    ]))
    connection.end()
    await new Promise((resolve) => setTimeout(resolve, 40))
    transport.stop()

    const observe = new ObserveState()
    for (const batch of traitBatches) {
      observe.apply(batch)
    }

    const inventory = buildInventory({
      observe,
      buckets: bucketMaps[bucketMaps.length - 1]!,
      ignoredDeviceIds: new Set(),
    })
    const devices = listDevices(inventory)

    expect(inventory.thermostats.size).toBe(1)
    expect(inventory.protects.size).toBe(1)
    expect(devices.some((device) => device.identity.kind === 'thermostat')).toBe(true)
    expect(devices.some((device) => device.identity.kind === 'protect')).toBe(true)
    expect(inventory.protects.get('PROTECT01')?.state.smoke).toBe('ok')
    expect(inventory.protects.get('PROTECT01')?.state.occupancySource).toBe('auto_away')
  })
})
