/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Safe readers for decoded Nest trait objects.
 *
 * Nest wraps nearly every scalar in a single-field message, so a temperature
 * arrives as `{ temperature: { value: { value: 21.8 } } }`. Worse, proto3 omits
 * fields at their default, so a reading of exactly zero and a reading that was
 * never sent are indistinguishable in the decoded object — both are `{}`.
 *
 * These readers therefore return `undefined` for anything they cannot confirm,
 * and callers treat `undefined` as "leave HomeKit alone" rather than
 * substituting a default. The alternative is a thermostat that reads 0 °C
 * whenever Nest omits a field.
 */

/** Read a nested property path, returning `undefined` at the first gap. */
function readPath(source: unknown, path: readonly string[]): unknown {
  let current = source

  for (const segment of path) {
    if (current === null || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

/** Read a finite number at a nested path. */
export function readNumber(source: unknown, ...path: readonly string[]): number | undefined {
  const value = readPath(source, path)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read a non-empty string at a nested path. */
export function readString(source: unknown, ...path: readonly string[]): string | undefined {
  const value = readPath(source, path)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read a flag that Nest encodes as an int32 rather than a bool.
 *
 * Present-and-nonzero is true; absent is `undefined`, not false. A capability
 * flag that is missing means "Nest did not say", and reporting that as "cannot
 * heat" would hide the heating controls on a thermostat that has them.
 */
export function readIntFlag(source: unknown, ...path: readonly string[]): boolean | undefined {
  const value = readPath(source, path)
  if (typeof value === 'boolean') {
    return value
  }
  return typeof value === 'number' ? value !== 0 : undefined
}

/**
 * Read a `Float_Indirect`-wrapped number.
 *
 * The wrapper is present with an absent inner `value` whenever the reading is
 * exactly zero *or* was not sent. Distinguishing them is impossible on the
 * wire, so this returns `undefined` for both: a spurious `undefined` costs one
 * stale HomeKit reading, whereas a spurious `0` shows freezing on a working
 * thermostat.
 */

import { MAX_REPORTED_TEMPERATURE_C, MIN_REPORTED_TEMPERATURE_C } from '../settings'
export function readIndirectFloat(source: unknown, ...path: readonly string[]): number | undefined {
  return readNumber(source, ...path, 'value')
}

/**
 * Read a Nest temperature trait, in Celsius.
 *
 * The shape is `TemperatureTrait.temperature.value.value` — a message wrapping
 * a message wrapping the float. Nest reports Celsius on the wire regardless of
 * what the device displays.
 */
export function readTemperatureC(trait: unknown): number | undefined {
  const celsius = readNumber(trait, 'temperature', 'value', 'value')
  return celsius !== undefined && isPlausibleTemperature(celsius) ? celsius : undefined
}

/** Read a Nest humidity trait, as a percentage. */
export function readHumidity(trait: unknown): number | undefined {
  const humidity = readNumber(trait, 'humidity', 'value', 'value')
  return humidity !== undefined && humidity >= 0 && humidity <= 100 ? humidity : undefined
}

/**
 * Reject readings outside what a habitable building can produce.
 *
 * Guards against a decode landing on the wrong field and against HomeKit
 * refusing a characteristic write that falls outside its permitted range,
 * which throws rather than clamping.
 */
export function isPlausibleTemperature(celsius: number): boolean {
  // Inclusive, and from the same constants the HAP characteristic props use —
  // duplicating the bounds as literals let the reader and the published range
  // disagree at exactly the boundary they are meant to share.
  return celsius >= MIN_REPORTED_TEMPERATURE_C && celsius <= MAX_REPORTED_TEMPERATURE_C
}

/** An enum protobufjs rendered as its symbolic name. */
export function readEnum(source: unknown, ...path: readonly string[]): string | undefined {
  return readString(source, ...path)
}
