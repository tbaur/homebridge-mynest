/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Endpoint resolution and the tuning constants that constrain
 * each other.
 *
 * `settings.ts` is mostly constants, but it also decides which Nest
 * environment every request goes to, and several of its values are only
 * correct relative to one another.
 */

import {
  APP_LAUNCH_BUCKET_TYPES,
  MAX_SETPOINT_C,
  MIN_SETPOINT_C,
  MIN_SETPOINT_SPAN_C,
  SETPOINT_STEP_C,
  MAX_DIAGNOSTICS_INTERVAL_SEC,
  MIN_DIAGNOSTICS_INTERVAL_SEC,
  OBSERVE_IDLE_TIMEOUT_MS,
  OBSERVE_SNAPSHOT_SETTLE_MS,
  REST_ALARM_FEED_STALE_MS,
  SUBSCRIBE_TIMEOUT_MS,
  appLaunchUrl,
  resolveEndpoints,
} from '../../src/settings'

describe('resolveEndpoints', () => {
  it('uses the production hosts by default', () => {
    const endpoints = resolveEndpoints(false)

    expect(endpoints.apiHostname).toBe('home.nest.com')
    expect(endpoints.sessionUrl).toBe('https://home.nest.com/session')
    expect(endpoints.grpcOrigin).toBe('https://grpc-web.production.nest.com')
  })

  it('switches every host together for field test', () => {
    // A mixed pair is rejected by Nest: field-test gRPC refuses a production
    // origin/referer exactly as production refuses a field-test one.
    const endpoints = resolveEndpoints(true)

    expect(endpoints.apiHostname).toBe('home.ft.nest.com')
    expect(endpoints.sessionUrl).toBe('https://home.ft.nest.com/session')
    expect(endpoints.grpcOrigin).toBe('https://grpc-web.ft.nest.com')
  })

  it('keeps the paths identical across environments', () => {
    const production = resolveEndpoints(false)
    const fieldTest = resolveEndpoints(true)

    expect(fieldTest.observePath).toBe(production.observePath)
    expect(fieldTest.batchUpdatePath).toBe(production.batchUpdatePath)
    expect(fieldTest.subscribePath).toBe(production.subscribePath)
  })
})

describe('appLaunchUrl', () => {
  it('builds the account-scoped path', () => {
    expect(appLaunchUrl(resolveEndpoints(false), '5551234'))
      .toBe('https://home.nest.com/api/0.1/user/5551234/app_launch')
  })

  it('encodes a user id that would otherwise alter the path', () => {
    expect(appLaunchUrl(resolveEndpoints(false), '../../evil'))
      .toBe('https://home.nest.com/api/0.1/user/..%2F..%2Fevil/app_launch')
  })
})

describe('constants that constrain each other', () => {
  it('keeps the Protect alarm feed alive across a full idle long-poll', () => {
    // A quiet house parks the subscribe request for its whole client timeout
    // without being unhealthy; a shorter stale window would fault every
    // Protect tile on an ordinary idle cycle.
    expect(REST_ALARM_FEED_STALE_MS).toBeGreaterThan(SUBSCRIBE_TIMEOUT_MS)
  })

  it('waits longer than the platform coalesce window before pruning a snapshot', () => {
    expect(OBSERVE_SNAPSHOT_SETTLE_MS).toBeGreaterThan(250)
  })

  it('keeps the Observe idle deadline well inside the diagnostics cap', () => {
    expect(OBSERVE_IDLE_TIMEOUT_MS).toBeLessThan(MAX_DIAGNOSTICS_INTERVAL_SEC * 1_000)
  })

  it('bounds the diagnostics interval below the setTimeout overflow point', () => {
    // Above 2^31-1 ms Node collapses a delay to 1 ms.
    expect(MAX_DIAGNOSTICS_INTERVAL_SEC * 1_000).toBeLessThan(2 ** 31 - 1)
    expect(MIN_DIAGNOSTICS_INTERVAL_SEC).toBeGreaterThan(0)
  })

  it('leaves room for the setpoint deadband inside the allowed range', () => {
    expect(MAX_SETPOINT_C - MIN_SETPOINT_C).toBeGreaterThan(MIN_SETPOINT_SPAN_C)
  })

  it('publishes a setpoint ceiling that Nest\'s own reaches once quantized', () => {
    // Nest's ceiling is 90 °F, or 32.222 °C. HAP quantizes onto the step grid
    // before range-checking, so that arrives as 32.0 and the ceiling does not
    // need headroom above it — only enough to contain the quantized value.
    const nestCeilingC = (90 - 32) * 5 / 9
    const quantized = SETPOINT_STEP_C
      * Math.round((nestCeilingC - MIN_SETPOINT_C) / SETPOINT_STEP_C) + MIN_SETPOINT_C
    expect(quantized).toBeLessThanOrEqual(MAX_SETPOINT_C)
    expect((MAX_SETPOINT_C - MIN_SETPOINT_C) % SETPOINT_STEP_C).toBe(0)
  })

  it('asks for every bucket type the state layer reads', () => {
    for (const bucket of ['topaz', 'kryptonite', 'where', 'shared', 'device', 'structure']) {
      expect(APP_LAUNCH_BUCKET_TYPES).toContain(bucket)
    }
  })
})
