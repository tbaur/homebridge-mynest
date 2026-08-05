/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Diagnostics report shapes for health/activity logging.
 */

/** Absolute device gauges, computed by the platform from its inventory. */
export interface DeviceGauges {
  /** Accessories currently published to HomeKit. */
  total: number
  /** Counts by Nest device kind. */
  byKind: {
    thermostat: number
    protect: number
    temperature_sensor: number
  }
  /** Devices seen only on Observe. */
  observeOnly: number
  /** Devices seen only on REST. */
  restOnly: number
  /** Devices seen on both transports. */
  both: number
  /** Devices skipped via `ignoredDeviceIds`. */
  ignored: number
}

/** Live Nest transport gauges from `NestTransport.status` (`api/transport.ts`). */
export interface TransportGauges {
  hasSession: boolean
  observeState: string
  restState: string
  observeFrames: number
  restCycles: number
  knownObjects: number
  lastObserveFrameAgeSec: number | null
  lastRestSuccessAgeSec: number | null
  /** Whether Protect smoke/CO may be treated as live from cached REST topaz. */
  isRestAlarmFeedAvailable: boolean
  /** Most recent Observe frames are failing to decode (likely a schema change). */
  isDecodeDegraded: boolean
  /** Per-transport circuit breaker states (`CLOSED` / `OPEN` / `HALF_OPEN`). */
  circuitBreaker: {
    rest: string
    observe: string
  }
}

/** A single heartbeat or boot/shutdown diagnostics report. */
export interface DiagnosticsSnapshot {
  /** Channel identifier, e.g. `health`, `diagnostics.start`, `diagnostics.stop`. */
  msg: string
  lifecycle: {
    health: 'healthy' | 'degraded'
    reasons: string[]
    uptimeSec: number
    pluginVersion: string
  }
  devices: DeviceGauges
  transport: TransportGauges & {
    /** Observe reconnects in this interval (or session cumulative on snapshot). */
    observeReconnects: number
    /** Successful REST subscribe / app_launch cycles in this interval. */
    restOk: number
    /** Failed REST cycles in this interval. */
    restFailed: number
    lastRestDurationMs: number | null
  }
  circuitBreaker: {
    rest: { state: string }
    observe: { state: string }
    /** Trips in this interval (or session cumulative on snapshot). */
    trips: number
    lastTripAt: number | null
  }
  session: {
    hasSession: boolean
    logins: number
  }
  api: {
    p50Ms: number
    p95Ms: number
    requests: number
    errors: number
  }
  activity: {
    /** Nest-originated HomeKit state pushes (not HomeKit commands). */
    externalChanges: number
    retries: number
  }
  /** Redacted config echo, present only on boot/shutdown snapshots. */
  config?: Record<string, unknown>
}
