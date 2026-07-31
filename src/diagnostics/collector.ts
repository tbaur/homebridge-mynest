/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Opt-in diagnostics collector for health/activity metrics.
 *
 * One collector is owned per platform instance. It accumulates cumulative
 * counters and a bounded latency window, and turns them into:
 *   - `buildHeartbeat()` — per-interval counter deltas + absolute gauges
 *   - `snapshot()`       — session cumulative totals + redacted config echo
 *   - `rollup()`         — `{ health, reasons[] }` health classification
 *
 * It only ever reads in-memory state via the supplied `readers`; it never
 * performs any network I/O.
 */

import type { ResolvedConfig } from '../types/config'
import type { DeviceGauges, DiagnosticsSnapshot, TransportGauges } from './types'

/** Maximum number of recent request latencies retained for percentile math. */
const LATENCY_WINDOW = 200

/** Recent request outcomes retained for the rollup error-rate calculation. */
const OUTCOME_WINDOW = 50

/** Minimum recent requests before the API error rate can mark health degraded. */
const API_ERROR_MIN_SAMPLES = 10

/** Recent error rate (0..1) above which health is considered degraded. */
const API_ERROR_RATE_THRESHOLD = 0.5

/**
 * Seconds Observe may stay silent (after the startup grace) before health
 * is degraded. Matches the transport's own silence warning window.
 */
const OBSERVE_DOWN_THRESHOLD_SEC = 60

/** Accessors the collector calls to read live in-memory state. */
export interface DiagnosticsReaders {
  transport: () => TransportGauges
  devices: () => DeviceGauges
  /** Platform has permanently stopped after Nest auth failure. */
  fatalActive: () => boolean
  /** Wall-clock seconds since platform start (for Observe silence grace). */
  uptimeSec: () => number
}

interface CollectorOptions {
  pluginVersion: string
  config: ResolvedConfig
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number
}

interface CounterSnapshot {
  apiRequests: number
  apiErrors: number
  restOk: number
  restFailed: number
  observeReconnects: number
  sessionLogins: number
  externalChanges: number
  retries: number
  breakerTrips: number
}

/** Health classification result. */
export interface HealthRollup {
  health: 'healthy' | 'degraded'
  reasons: string[]
}

/** Accumulates diagnostics counters and renders heartbeat/snapshot reports. */
export class DiagnosticsCollector {
  readonly #now: () => number
  readonly #startedAtMs: number
  readonly #pluginVersion: string
  readonly #configEcho: Record<string, unknown>

  #apiRequests = 0
  #apiErrors = 0
  #restOk = 0
  #restFailed = 0
  #observeReconnects = 0
  #sessionLogins = 0
  #externalChanges = 0
  #retries = 0
  #breakerTrips = 0
  #lastBreakerTripAt: number | null = null

  #lastRestDurationMs: number | null = null

  readonly #latencies: number[] = []
  readonly #recentOutcomes: boolean[] = []

  #marker: CounterSnapshot

  constructor(options: CollectorOptions) {
    this.#now = options.now ?? Date.now
    this.#startedAtMs = this.#now()
    this.#pluginVersion = options.pluginVersion
    this.#configEcho = redactConfig(options.config)
    this.#marker = this.#captureCounters()
  }

  /**
   * Record a single API request outcome and its wall-clock duration.
   *
   * Latency is only sampled when a network fetch was actually attempted
   * (`networked`), so pre-flight skips do not skew percentiles.
   */
  apiRequest(latencyMs: number, ok: boolean, networked = true): void {
    this.#apiRequests++
    if (!ok) {
      this.#apiErrors++
    }

    if (networked && Number.isFinite(latencyMs) && latencyMs >= 0) {
      this.#latencies.push(latencyMs)
      if (this.#latencies.length > LATENCY_WINDOW) {
        this.#latencies.shift()
      }
    }

    this.#recentOutcomes.push(ok)
    if (this.#recentOutcomes.length > OUTCOME_WINDOW) {
      this.#recentOutcomes.shift()
    }
  }

  /** Record the result of a REST subscribe / app_launch cycle. */
  restCycle(ok: boolean, durationMs: number): void {
    if (ok) {
      this.#restOk++
    } else {
      this.#restFailed++
    }
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      this.#lastRestDurationMs = durationMs
    }
  }

  /** Record an Observe reconnect (a new HTTP/2 session is opening). */
  observeReconnect(): void {
    this.#observeReconnects++
  }

  /** Record a successful Nest session open / refresh. */
  sessionLogin(): void {
    this.#sessionLogins++
  }

  /** Record a Nest-originated HomeKit state push. */
  externalChange(): void {
    this.#externalChanges++
  }

  /** Record a retry attempt. */
  retry(): void {
    this.#retries++
  }

  /** Record a circuit-breaker trip (transition into the open state). */
  breakerTrip(): void {
    this.#breakerTrips++
    this.#lastBreakerTripAt = this.#now()
  }

  /**
   * Nearest-rank percentile (0..100) over the bounded recent-latency window.
   * Returns 0 when no samples are available.
   */
  percentile(p: number): number {
    if (this.#latencies.length === 0) {
      return 0
    }
    const sorted = [...this.#latencies].sort((a, b) => a - b)
    const clamped = Math.min(100, Math.max(0, p))
    const rank = Math.ceil((clamped / 100) * sorted.length)
    const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
    return sorted[index]!
  }

  /**
   * Classify current health from live readers.
   *
   * Degraded when Nest auth is fatal, either transport has given up on 403s,
   * a circuit breaker is open or probing, Observe has gone silent past the
   * grace window, or the recent API error rate is high. Observe-only Protects
   * missing REST smoke are expected and are not a degradation reason.
   */
  rollup(readers: DiagnosticsReaders): HealthRollup {
    const reasons: string[] = []
    const transport = readers.transport()

    if (readers.fatalActive()) {
      reasons.push('fatalAuth')
    }

    if (transport.observeState === 'forbidden_dead') {
      reasons.push('observeForbiddenDead')
    }

    if (transport.restState === 'forbidden_dead') {
      reasons.push('restForbiddenDead')
    }

    if (
      transport.observeState === 'forbidden_dead'
      && transport.restState === 'forbidden_dead'
    ) {
      reasons.push('bothTransportsDead')
    }

    const restBreaker = transport.circuitBreaker.rest
    const observeBreaker = transport.circuitBreaker.observe
    if (restBreaker !== 'CLOSED' || observeBreaker !== 'CLOSED') {
      reasons.push('circuitBreakerOpen')
    }

    if (!transport.isRestAlarmFeedAvailable) {
      reasons.push('restAlarmFeedUnavailable')
    }

    const uptimeSec = readers.uptimeSec()
    if (
      transport.observeState !== 'forbidden_dead'
      && transport.observeState !== 'stopped'
      && uptimeSec >= OBSERVE_DOWN_THRESHOLD_SEC
      && (transport.lastObserveFrameAgeSec === null
        || transport.lastObserveFrameAgeSec >= OBSERVE_DOWN_THRESHOLD_SEC)
    ) {
      reasons.push('observeDown')
    }

    const total = this.#recentOutcomes.length
    if (total >= API_ERROR_MIN_SAMPLES) {
      const errors = this.#recentOutcomes.filter((ok) => !ok).length
      if (errors / total > API_ERROR_RATE_THRESHOLD) {
        reasons.push('apiErrorRateHigh')
      }
    }

    return {
      health: reasons.length > 0 ? 'degraded' : 'healthy',
      reasons,
    }
  }

  /**
   * Build a heartbeat report: counters are deltas since the previous heartbeat
   * (the marker is then advanced) and everything else is an absolute gauge.
   */
  buildHeartbeat(readers: DiagnosticsReaders): DiagnosticsSnapshot {
    const current = this.#captureCounters()

    const counters: CounterValues = {
      observeReconnects: current.observeReconnects - this.#marker.observeReconnects,
      restOk: current.restOk - this.#marker.restOk,
      restFailed: current.restFailed - this.#marker.restFailed,
      requests: current.apiRequests - this.#marker.apiRequests,
      errors: current.apiErrors - this.#marker.apiErrors,
      logins: current.sessionLogins - this.#marker.sessionLogins,
      externalChanges: current.externalChanges - this.#marker.externalChanges,
      retries: current.retries - this.#marker.retries,
      trips: current.breakerTrips - this.#marker.breakerTrips,
    }

    const report = this.#buildReport('health', counters, readers)
    this.#marker = current
    return report
  }

  /**
   * Build a session-cumulative snapshot (no marker advance), including the
   * redacted config echo. Used for boot/shutdown reports.
   */
  snapshot(msg: string, readers: DiagnosticsReaders): DiagnosticsSnapshot {
    const counters: CounterValues = {
      observeReconnects: this.#observeReconnects,
      restOk: this.#restOk,
      restFailed: this.#restFailed,
      requests: this.#apiRequests,
      errors: this.#apiErrors,
      logins: this.#sessionLogins,
      externalChanges: this.#externalChanges,
      retries: this.#retries,
      trips: this.#breakerTrips,
    }

    const report = this.#buildReport(msg, counters, readers)
    report.config = { ...this.#configEcho }
    return report
  }

  #uptimeSec(): number {
    return Math.round((this.#now() - this.#startedAtMs) / 1000)
  }

  #captureCounters(): CounterSnapshot {
    return {
      apiRequests: this.#apiRequests,
      apiErrors: this.#apiErrors,
      restOk: this.#restOk,
      restFailed: this.#restFailed,
      observeReconnects: this.#observeReconnects,
      sessionLogins: this.#sessionLogins,
      externalChanges: this.#externalChanges,
      retries: this.#retries,
      breakerTrips: this.#breakerTrips,
    }
  }

  #buildReport(
    msg: string,
    counters: CounterValues,
    readers: DiagnosticsReaders,
  ): DiagnosticsSnapshot {
    const transport = readers.transport()
    const { health, reasons } = this.rollup(readers)

    return {
      msg,
      lifecycle: {
        health,
        reasons,
        uptimeSec: this.#uptimeSec(),
        pluginVersion: this.#pluginVersion,
      },
      devices: readers.devices(),
      transport: {
        ...transport,
        observeReconnects: counters.observeReconnects,
        restOk: counters.restOk,
        restFailed: counters.restFailed,
        lastRestDurationMs: this.#lastRestDurationMs,
      },
      circuitBreaker: {
        rest: { state: transport.circuitBreaker.rest },
        observe: { state: transport.circuitBreaker.observe },
        trips: counters.trips,
        lastTripAt: this.#lastBreakerTripAt,
      },
      session: {
        hasSession: transport.hasSession,
        logins: counters.logins,
      },
      api: {
        p50Ms: this.percentile(50),
        p95Ms: this.percentile(95),
        requests: counters.requests,
        errors: counters.errors,
      },
      activity: {
        externalChanges: counters.externalChanges,
        retries: counters.retries,
      },
    }
  }
}

interface CounterValues {
  observeReconnects: number
  restOk: number
  restFailed: number
  requests: number
  errors: number
  logins: number
  externalChanges: number
  retries: number
  trips: number
}

/**
 * Build a redacted echo of the plugin config for snapshots.
 *
 * The access token is never included; the ignored-device list is reduced to a
 * count so the echo stays free of device identifiers.
 */
function redactConfig(config: ResolvedConfig): Record<string, unknown> {
  return {
    diagnosticsInterval: config.diagnosticsInterval,
    structuredLogs: config.structuredLogs,
    fieldTest: config.fieldTest,
    allowThermostatControl: config.allowThermostatControl,
    exposeProtectOccupancy: config.exposeProtectOccupancy,
    exposeProtectTemperature: config.exposeProtectTemperature,
    ignoredDeviceIds: config.ignoredDeviceIds.size,
    debug: config.debug,
  }
}
