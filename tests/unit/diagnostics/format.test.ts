/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The human-readable diagnostics line.
 *
 * This is what an operator actually reads, so every channel label and
 * transport state has to render as something meaningful rather than falling
 * through to a raw enum.
 */

import { formatDiagnosticLine } from '../../../src/diagnostics/format'
import type { DiagnosticsSnapshot } from '../../../src/diagnostics/types'

function snapshot(overrides: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    msg: 'health',
    lifecycle: { health: 'healthy', reasons: [], uptimeSec: 120, pluginVersion: '1.1.0' },
    devices: {
      total: 4,
      byKind: { thermostat: 1, protect: 2, temperature_sensor: 1 },
      observeOnly: 1,
      restOnly: 1,
      both: 2,
      ignored: 0,
    },
    transport: {
      hasSession: true,
      observeState: 'connected',
      restState: 'running',
      observeFrames: 10,
      restCycles: 3,
      knownObjects: 7,
      lastObserveFrameAgeSec: 5,
      lastRestSuccessAgeSec: 9,
      isRestAlarmFeedAvailable: true,
      circuitBreaker: { rest: 'CLOSED', observe: 'CLOSED' },
      observeReconnects: 0,
      restOk: 3,
      restFailed: 0,
      lastRestDurationMs: 120,
    },
    circuitBreaker: {
      rest: { state: 'CLOSED' },
      observe: { state: 'CLOSED' },
      trips: 0,
      lastTripAt: null,
    },
    session: { hasSession: true, logins: 1 },
    api: { p50Ms: 40, p95Ms: 90, requests: 12, errors: 0 },
    activity: { externalChanges: 5, retries: 0 },
    ...overrides,
  } as DiagnosticsSnapshot
}

describe('formatDiagnosticLine', () => {
  it('summarises a healthy home', () => {
    const line = formatDiagnosticLine(snapshot())

    expect(line).toContain('Health: healthy')
    expect(line).toContain('devices 4 (1T/2P/1S)')
    expect(line).toContain('obs live rest live')
    expect(line).toContain('api p50 40ms p95 90ms (req 12, err 0)')
    expect(line).not.toContain('breaker')
  })

  it.each([
    ['health', 'Health'],
    ['diagnostics.start', 'Diagnostics start'],
    ['diagnostics.stop', 'Diagnostics stop'],
    ['health.degraded', 'Health degraded'],
    ['health.recovered', 'Health recovered'],
  ])('labels the %s channel as "%s"', (msg, label) => {
    expect(formatDiagnosticLine(snapshot({ msg }))).toContain(`${label}:`)
  })

  it('passes an unrecognised channel through unchanged', () => {
    expect(formatDiagnosticLine(snapshot({ msg: 'something.new' }))).toContain('something.new:')
  })

  it('lists the reasons behind a degraded verdict', () => {
    const line = formatDiagnosticLine(snapshot({
      lifecycle: {
        health: 'degraded',
        reasons: ['observeDown', 'apiErrorRateHigh'],
        uptimeSec: 300,
        pluginVersion: '1.1.0',
      },
    }))

    expect(line).toContain('degraded [observeDown, apiErrorRateHigh]')
  })

  it('names a transport that gave up on authentication', () => {
    const base = snapshot()
    const line = formatDiagnosticLine({
      ...base,
      transport: { ...base.transport, observeState: 'forbidden_dead', restState: 'stopped' },
    })

    expect(line).toContain('obs auth-failed rest stopped')
  })

  it('reports connecting as-is rather than claiming a live stream', () => {
    const base = snapshot()
    const line = formatDiagnosticLine({
      ...base,
      transport: { ...base.transport, observeState: 'connecting' },
    })

    expect(line).toContain('obs connecting')
  })

  it('shows only the breakers that are not closed', () => {
    const base = snapshot()
    const line = formatDiagnosticLine({
      ...base,
      circuitBreaker: { ...base.circuitBreaker, rest: { state: 'OPEN' } },
    })

    expect(line).toContain('breaker rest=OPEN')
    expect(line).not.toContain('obs=')
  })
})
