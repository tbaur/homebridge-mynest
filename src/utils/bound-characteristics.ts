/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Characteristic binding that pushes live values under HAP 2.
 *
 * This solves a specific, load-bearing problem. Under HAP 1 a plugin could push
 * a fresh reading by calling `characteristic.getValue()`, which re-ran the
 * registered `onGet` handler and notified subscribers with the result. HAP 2
 * removed `getValue()`, and the two obvious repairs are both wrong:
 *
 *   - Keep calling `getValue()`. The plugin throws on Homebridge 2 at boot.
 *   - Call `updateValue(characteristic.value)`. It boots, but `.value` is the
 *     *cached* value, so every push writes back what HomeKit already had. The
 *     process looks healthy and no reading ever changes again.
 *
 * The community Nest plugin shipped each of those in turn (4.6.9 and 4.6.10).
 * The fix is to keep the read function next to the characteristic, so a push
 * can recompute from current device state and hand the result to
 * `updateValue`. That is what {@link CharacteristicBinder} stores.
 */

import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge'
import type { Logger } from './logger'

/** Computes a characteristic's current value from device state. */
export type CharacteristicReader = () => CharacteristicValue | null | undefined

/** Applies a HomeKit-originated write to the device. */
export type CharacteristicWriter = (value: CharacteristicValue) => Promise<void>

type CharacteristicType = WithUUID<new () => Characteristic>

/**
 * Reader failures warned about before falling back to debug.
 *
 * A broken mapping throws on every refresh, so this has to be visible without
 * flooding the log of an otherwise healthy install.
 */
const MAX_READ_FAILURE_WARNINGS = 3

interface Binding {
  readonly characteristic: Characteristic
  readonly service: Service
  /** Mutable so a later re-bind of the same characteristic can swap the reader. */
  read: CharacteristicReader
  readonly name: string
}

/**
 * Holds every characteristic an accessory publishes, with how to read it.
 *
 * Accessories bind once at construction and call {@link refresh} whenever new
 * device state arrives; they never push values characteristic by characteristic.
 */
export class CharacteristicBinder {
  #bindings: Binding[] = []
  #readFailures = 0
  readonly #log: Logger
  readonly #label: string

  /**
   * @param label Device name written into failure messages. `createScopedLogger`
   *   deliberately does not prefix lines, so without it
   *   `Could not compute Smoke Detected` names no device — unactionable in a
   *   house with a dozen Protects.
   */
  constructor(log: Logger, label = 'accessory') {
    this.#log = log
    this.#label = label
  }

  /**
   * Publish a characteristic and record how to compute its value.
   *
   * The `onGet` handler is registered from the same reader, so a direct HomeKit
   * read and a plugin-initiated push can never disagree.
   *
   * @param options.write When present, makes the characteristic writable and
   *   routes HomeKit writes to the device.
   */
  bind(
    service: Service,
    type: CharacteristicType,
    read: CharacteristicReader,
    options: {
      write?: CharacteristicWriter
      /**
       * Throws when the reader has no value. The accessory list turns a throw
       * into the characteristic default, so smoke and CO must not use this.
       * They return null, and HAP keeps the cached value.
       */
      unavailable?: () => never
      /**
       * HomeKit read to use when the reader has no value. `refresh` still
       * skips the push, so a missing value does not overwrite the cache.
       */
      whenMissing?: () => CharacteristicValue
    } = {},
  ): Characteristic {
    const characteristic = service.getCharacteristic(type)
    const name = describeCharacteristic(characteristic, type)
    const existing = this.#bindings.find((binding) => binding.characteristic === characteristic)

    // Optional services (Protect occupancy, thermostat humidity) may appear
    // after the first Nest update. Re-binding the same characteristic must
    // replace the reader rather than stacking a second onGet / refresh entry.
    if (existing) {
      existing.read = read
      return characteristic
    }

    characteristic.onGet(() => {
      try {
        const value = read()
        if (value === null || value === undefined) {
          if (options.unavailable) {
            options.unavailable()
          }
          if (options.whenMissing) {
            return options.whenMissing()
          }
          // Returning null makes HAP log an illegal-value warning and, on the
          // accessory list, a thrown getter is replaced with the default.
          // The cached value is the honest answer when Nest has not sent a new one.
          if (characteristic.value !== null && characteristic.value !== undefined) {
            return characteristic.value as CharacteristicValue
          }
          return null
        }
        return value
      } catch (error) {
        if (isHapStatusError(error)) {
          throw error
        }
        // HAP already catches a throw from onGet and, on the accessory list,
        // replaces it with the characteristic default. Returning null makes
        // the read succeed with the previous value when one exists.
        this.#noteReadFailure(name, error)
        return null
      }
    })

    if (options.write) {
      characteristic.onSet(async (value) => {
        await options.write!(value)
      })
    }

    this.#bindings.push({ characteristic, service, read, name })
    return characteristic
  }

  /**
   * Drop every binding that belongs to a service about to be removed.
   *
   * Without this, `refresh` would keep calling `updateValue` on characteristics
   * whose service is gone from the accessory.
   */
  unbindService(service: Service): void {
    this.#bindings = this.#bindings.filter((binding) => binding.service !== service)
  }

  /**
   * Recompute and push every bound characteristic.
   *
   * Readers returning `null`/`undefined` are skipped rather than written as a
   * default. A Nest device that has not reported a trait yet must keep its last
   * known value in HomeKit; substituting `0` would show a thermostat reading
   * 0 °C or a smoke alarm reporting all-clear on no evidence.
   *
   * A throwing reader is logged and skipped so one bad mapping cannot stop the
   * rest of the accessory from updating.
   */
  refresh(): void {
    for (const binding of this.#bindings) {
      let value: CharacteristicValue | null | undefined

      try {
        value = binding.read()
      } catch (error) {
        this.#noteReadFailure(binding.name, error)
        continue
      }

      if (value === null || value === undefined) {
        continue
      }

      binding.characteristic.updateValue(value)
    }
  }

  /** Number of bound characteristics. Exposed for tests and diagnostics. */
  get size(): number {
    return this.#bindings.length
  }

  /**
   * Warned for the first few, then dropped to debug.
   *
   * A state-mapping bug throws on every refresh forever, and
   * `createScopedLogger` discards debug entirely unless the operator enabled
   * it. At debug only, an accessory silently stopped updating and the log
   * said nothing.
   */
  #noteReadFailure(name: string, error: unknown): void {
    this.#readFailures++
    const message = `${this.#label}: could not compute ${name} `
      + `(${this.#readFailures} failure(s)): `
      + `${error instanceof Error ? error.message : String(error)}`
    if (this.#readFailures <= MAX_READ_FAILURE_WARNINGS) {
      this.#log.warn(message)
    } else {
      this.#log.debug(message)
    }
  }
}

/**
 * Homebridge exports HapStatusError as a type only, and the instance's
 * `name` is `Error`. The status code lives on `hapStatus`.
 */
function isHapStatusError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'hapStatus' in error
    && typeof (error as { hapStatus: unknown }).hapStatus === 'number'
}

/**
 * A readable name for a characteristic, for log messages.
 *
 * HAP populates `displayName` on real characteristics; the UUID is the fallback
 * so this never throws on a stub.
 */

function describeCharacteristic(
  characteristic: Characteristic,
  type: CharacteristicType,
): string {
  return characteristic.displayName || type.UUID
}
