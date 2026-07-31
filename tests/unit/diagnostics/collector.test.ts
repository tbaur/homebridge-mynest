/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview DiagnosticsCollector deltas, rollup, and redacted snapshots.
 */

import { DiagnosticsCollector } from '../../../src/diagnostics/collector'
import type { DiagnosticsReaders } from '../../../src/diagnostics/collector'
import type { ResolvedConfig } from '../../../src/types/config'
import { formatDiagnosticLine } from '../../../src/diagnostics/format'

const baseConfig = (): ResolvedConfig => ({
  name: 'MyNest',
  accessToken: 'b'.repeat(120),
  fieldTest: false,
  allowThermostatControl: false,
  exposeGlobalEcoSwitch: false,
  exposeProtectOccupancy: true,
  exposeProtectTemperature: false,
  ignoredDeviceIds: new Set(['ABC']),
  diagnosticsInterval: 60,
  structuredLogs: false,
  debug: false,
})

interface MutableReaders {
  readers: DiagnosticsReaders
  observeState: { value: string }
  restState: { value: string }
  lastObserveFrameAgeSec: { value: number | null }
  restBreaker: { value: string }
  observeBreaker: { value: string }
  fatalActive: { value: boolean }
  uptimeSec: { value: number }
}

const makeReaders = (): MutableReaders => {
  const observeState = { value: 'connected' }
  const restState = { value: 'running' }
  const lastObserveFrameAgeSec = { value: 2 as number | null }
  const restBreaker = { value: 'CLOSED' }
  const observeBreaker = { value: 'CLOSED' }
  const fatalActive = { value: false }
  const uptimeSec = { value: 120 }

  const readers: DiagnosticsReaders = {
    transport: () => ({
      hasSession: true,
      observeState: observeState.value,
      restState: restState.value,
      observeFrames: 10,
      restCycles: 4,
      knownObjects: 6,
      lastObserveFrameAgeSec: lastObserveFrameAgeSec.value,
      lastRestSuccessAgeSec: 2,
      isRestAlarmFeedAvailable: true,
      circuitBreaker: {
        rest: restBreaker.value,
        observe: observeBreaker.value,
      },
    }),
    devices: () => ({
      total: 5,
      byKind: { thermostat: 2, protect: 2, temperature_sensor: 1 },
      observeOnly: 2,
      restOnly: 0,
      both: 3,
      ignored: 1,
    }),
    fatalActive: () => fatalActive.value,
    uptimeSec: () => uptimeSec.value,
  }

  return {
    readers,
    observeState,
    restState,
    lastObserveFrameAgeSec,
    restBreaker,
    observeBreaker,
    fatalActive,
    uptimeSec,
  }
}

describe('DiagnosticsCollector', () => {
  it('reports per-interval deltas and advances the marker each heartbeat', () => {
    const m = makeReaders()
    const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })

    collector.apiRequest(100, true)
    collector.apiRequest(200, false)
    collector.restCycle(true, 42)
    collector.restCycle(false, 10)
    collector.sessionLogin()
    collector.observeReconnect()
    collector.externalChange()
    collector.retry()

    const first = collector.buildHeartbeat(m.readers)
    expect(first.api.requests).toBe(2)
    expect(first.api.errors).toBe(1)
    expect(first.transport.restOk).toBe(1)
    expect(first.transport.restFailed).toBe(1)
    expect(first.transport.lastRestDurationMs).toBe(10)
    expect(first.transport.observeReconnects).toBe(1)
    expect(first.session.logins).toBe(1)
    expect(first.activity.externalChanges).toBe(1)
    expect(first.activity.retries).toBe(1)

    const second = collector.buildHeartbeat(m.readers)
    expect(second.api.requests).toBe(0)
    expect(second.transport.restOk).toBe(0)
    expect(second.session.logins).toBe(0)
  })

  it('includes a redacted config echo on snapshots and never the access token', () => {
    const m = makeReaders()
    const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
    const snap = collector.snapshot('diagnostics.start', m.readers)

    expect(snap.config).toMatchObject({
      diagnosticsInterval: 60,
      ignoredDeviceIds: 1,
      debug: false,
    })
    expect(JSON.stringify(snap.config)).not.toContain('bbbb')
    expect(snap.config).not.toHaveProperty('accessToken')
  })

  it('marks health degraded for fatal auth and dead transports', () => {
    const m = makeReaders()
    const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })

    m.fatalActive.value = true
    expect(collector.rollup(m.readers)).toEqual({
      health: 'degraded',
      reasons: expect.arrayContaining(['fatalAuth']),
    })

    m.fatalActive.value = false
    m.observeState.value = 'forbidden_dead'
    m.restState.value = 'forbidden_dead'
    expect(collector.rollup(m.readers).reasons).toEqual(
      expect.arrayContaining(['observeForbiddenDead', 'restForbiddenDead', 'bothTransportsDead']),
    )
  })

  it('marks observeDown only when Observe stays connecting past the grace window', () => {
    const m = makeReaders()
    const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })

    // Connected + quiet (old last frame) is normal Nest silence, not down.
    m.observeState.value = 'connected'
    m.lastObserveFrameAgeSec.value = 90
    m.uptimeSec.value = 120
    expect(collector.rollup(m.readers).reasons).not.toContain('observeDown')

    m.observeState.value = 'connecting'
    expect(collector.rollup(m.readers).reasons).toContain('observeDown')

    m.uptimeSec.value = 10
    expect(collector.rollup(m.readers).reasons).not.toContain('observeDown')
  })

  it('omits latency samples when sampleLatency is false', () => {
    const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })

    collector.apiRequest(100, true)
    collector.apiRequest(120_000, true, { sampleLatency: false })

    expect(collector.percentile(95)).toBe(100)
  })

  it('marks apiErrorRateHigh once enough recent failures accumulate', () => {
    const m = makeReaders()
    const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })

    // 6 failures of 10 samples → 60% > 50% threshold.
    for (let i = 0; i < 10; i++) {
      collector.apiRequest(10, i >= 6)
    }

    expect(collector.rollup(m.readers).reasons).toContain('apiErrorRateHigh')
  })

  it('marks circuitBreakerOpen when either transport breaker is not closed', () => {
    const m = makeReaders()
    const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })

    m.restBreaker.value = 'OPEN'
    expect(collector.rollup(m.readers).reasons).toContain('circuitBreakerOpen')

    m.restBreaker.value = 'CLOSED'
    m.observeBreaker.value = 'HALF_OPEN'
    expect(collector.rollup(m.readers).reasons).toContain('circuitBreakerOpen')
  })

  it('marks restAlarmFeedUnavailable when Protect smoke/CO must not be treated as live', () => {
    const m = makeReaders()
    const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
    const readers: DiagnosticsReaders = {
      ...m.readers,
      transport: () => ({
        ...m.readers.transport(),
        isRestAlarmFeedAvailable: false,
      }),
    }

    expect(collector.rollup(readers).reasons).toContain('restAlarmFeedUnavailable')
  })

  it('records breaker trips and surfaces them on snapshots', () => {
    const m = makeReaders()
    let now = 1_700_000_000_000
    const collector = new DiagnosticsCollector({
      pluginVersion: '0.1.0',
      config: baseConfig(),
      now: () => now,
    })

    collector.breakerTrip()
    now += 1
    const snap = collector.snapshot('diagnostics.start', m.readers)

    expect(snap.circuitBreaker.trips).toBe(1)
    expect(snap.circuitBreaker.lastTripAt).toBe(1_700_000_000_000)
    expect(snap.circuitBreaker.rest.state).toBe('CLOSED')
  })

  it('formats a sibling-style human health line', () => {
    const m = makeReaders()
    const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
    collector.apiRequest(82, true)
    collector.apiRequest(240, true)
    const report = collector.buildHeartbeat(m.readers)

    expect(formatDiagnosticLine(report)).toBe(
      'Health: healthy | devices 5 (2T/2P/1S) | obs live rest live | '
      + `api p50 ${report.api.p50Ms}ms p95 ${report.api.p95Ms}ms (req 2, err 0)`,
    )
  })

  it('includes open breakers in the human health line', () => {
    const m = makeReaders()
    const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
    m.restBreaker.value = 'OPEN'
    const report = collector.buildHeartbeat(m.readers)

    expect(formatDiagnosticLine(report)).toContain('breaker rest=OPEN')
  })
})
