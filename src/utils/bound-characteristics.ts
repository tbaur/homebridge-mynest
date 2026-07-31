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
  readonly #log: Logger

  constructor(log: Logger) {
    this.#log = log
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
    options: { write?: CharacteristicWriter } = {},
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
      const value = read()
      // `null` tells HAP "not available yet" and leaves the cached value in
      // place, which is the honest answer before the first Nest update lands.
      return value ?? null
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
        this.#log.debug(
          `Could not compute ${binding.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
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
