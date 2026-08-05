/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Human-readable formatting for diagnostics reports.
 */

import type { DiagnosticsSnapshot } from './types'

/** Human-readable label for a diagnostics channel. */
function diagnosticLabel(msg: string): string {
  switch (msg) {
    case 'health':
      return 'Health'
    case 'diagnostics.start':
      return 'Diagnostics start'
    case 'diagnostics.stop':
      return 'Diagnostics stop'
    case 'health.degraded':
      return 'Health degraded'
    case 'health.recovered':
      return 'Health recovered'
    default:
      return msg
  }
}

/** Short operator-facing label for a Nest transport lifecycle state. */
function formatTransportState(state: string): string {
  switch (state) {
    case 'connected':
    case 'running':
      return 'live'
    case 'forbidden_dead':
      return 'auth-failed'
    default:
      // `connecting` and `stopped` are already the words an operator wants.
      return state
  }
}

/** Concise human-readable summary line for a diagnostics report. */
export function formatDiagnosticLine(report: DiagnosticsSnapshot): string {
  const { lifecycle, devices, transport, api, circuitBreaker } = report
  const reasonText = lifecycle.reasons.length > 0 ? ` [${lifecycle.reasons.join(', ')}]` : ''
  const kindText = [
    `${devices.byKind.thermostat}T`,
    `${devices.byKind.protect}P`,
    `${devices.byKind.temperature_sensor}S`,
  ].join('/')

  const breakerParts: string[] = []
  if (circuitBreaker.rest.state !== 'CLOSED') {
    breakerParts.push(`rest=${circuitBreaker.rest.state}`)
  }
  if (circuitBreaker.observe.state !== 'CLOSED') {
    breakerParts.push(`obs=${circuitBreaker.observe.state}`)
  }
  const breakerText = breakerParts.length > 0 ? ` | breaker ${breakerParts.join(' ')}` : ''

  return (
    `${diagnosticLabel(report.msg)}: ${lifecycle.health}${reasonText} | `
    + `devices ${devices.total} (${kindText}) | `
    + `obs ${formatTransportState(transport.observeState)} `
    + `rest ${formatTransportState(transport.restState)}`
    + `${breakerText} | `
    + `api p50 ${api.p50Ms}ms p95 ${api.p95Ms}ms (req ${api.requests}, err ${api.errors})`
  )
}
