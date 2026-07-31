/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Platform configuration, as written by the user and as resolved.
 */

/** The platform block exactly as it appears in the Homebridge config file. */
export interface MyNestPlatformConfig {
  platform: string
  name?: string

  /**
   * Nest Account `access_token`, copied from https://home.nest.com/session.
   *
   * This plugin deliberately supports only Nest Account tokens. Google account
   * sign-in requires replaying a browser cookie through Google's own auth flow,
   * which breaks without warning and asks users to paste a credential far more
   * powerful than this one.
   */
  accessToken?: unknown

  /** Talk to Nest's field-test environment instead of production. */
  fieldTest?: unknown

  /**
   * Allow HomeKit to change thermostat setpoints and modes.
   *
   * Off by default. Everything else the plugin does is read-only, and a
   * misbehaving automation that can drive the heating is a different class of
   * risk from one that can only read it.
   */
  allowThermostatControl?: unknown

  /** Publish an occupancy sensor for each Nest Protect that reports one. */
  exposeProtectOccupancy?: unknown

  /** Publish the temperature and humidity a Nest Protect measures. */
  exposeProtectTemperature?: unknown

  /** Nest device IDs or serial numbers to leave out of HomeKit entirely. */
  ignoredDeviceIds?: unknown

  /**
   * Seconds between opt-in health heartbeats in the Homebridge log.
   *
   * `0` (default) disables them. A non-zero value below 30 is raised to 30.
   */
  diagnosticsInterval?: unknown

  /**
   * When diagnostics are enabled, also emit a machine-readable JSON line
   * alongside each human-readable health report.
   */
  structuredLogs?: unknown

  /** Emit verbose diagnostics, including per-trait Observe updates. */
  debug?: unknown
}

/** Configuration after validation, with every value present and in range. */
export interface ResolvedConfig {
  name: string
  accessToken: string
  fieldTest: boolean
  allowThermostatControl: boolean
  exposeProtectOccupancy: boolean
  exposeProtectTemperature: boolean
  /** Matched against both the Observe resource id and the REST serial number. */
  ignoredDeviceIds: ReadonlySet<string>
  /** Seconds between health heartbeats; `0` disables. */
  diagnosticsInterval: number
  structuredLogs: boolean
  debug: boolean
}

/** Outcome of validating user configuration. */
export interface ConfigValidationResult {
  config: ResolvedConfig
  /** Non-fatal problems worth telling the user about. */
  warnings: string[]
}
