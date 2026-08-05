/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Building Nest Temperature Sensor state.
 */

import type { TemperatureSensorState } from '../types/device'
import type { KryptoniteBucket } from '../types/nest'
import type { ObserveState } from './observe-state'
import { isPlausibleTemperature, readNumber, readTemperatureC } from './traits'

/**
 * Battery percentage at or below which HomeKit is told the battery is low.
 *
 * Matches the threshold Nest itself uses to prompt for a replacement.
 */
export const LOW_BATTERY_PERCENT = 20

/**
 * Cell voltage at or below which the battery is treated as low.
 *
 * Only used when REST does not report a percentage. These sensors run a single
 * 3 V lithium cell whose voltage sits flat near 3.0 V for most of its life and
 * falls away at the end, so 2.6 V is late in that curve but still ahead of the
 * device going quiet.
 */
export const LOW_BATTERY_VOLTS = 2.6

/**
 * Build sensor state from both transports.
 *
 * Observe carries the live temperature; REST carries the battery percentage,
 * which Observe reports only as a raw cell voltage.
 */
export function readTemperatureSensorState(options: {
  state: ObserveState
  resourceId: string
  kryptonite: KryptoniteBucket | undefined
}): TemperatureSensorState {
  const { state, resourceId, kryptonite } = options

  // Range-checked because `battery_level` means percent on a kryptonite bucket
  // but millivolts on a topaz one. Handing HomeKit a millivolt reading would
  // trip HAP's 0-100 clamp and warn on every push.
  const batteryLevel = readPercentage(readNumber(kryptonite, 'battery_level'))
  const volts = readNumber(state.trait(resourceId, 'battery'), 'assessedVoltage', 'value')

  return {
    temperatureC: readTemperatureC(state.trait(resourceId, 'current_temperature'))
      ?? readTemperatureC(state.trait(resourceId, 'temperature'))
      ?? (
        typeof kryptonite?.current_temperature === 'number'
        && isPlausibleTemperature(kryptonite.current_temperature)
          ? kryptonite.current_temperature
          : undefined
      ),
    batteryLevel,
    isBatteryLow: resolveLowBattery(batteryLevel, volts),
  }
}

function readPercentage(value: number | undefined): number | undefined {
  return value !== undefined && value >= 0 && value <= 100 ? value : undefined
}

/** Prefer the reported percentage; fall back to voltage; otherwise say nothing. */
function resolveLowBattery(
  batteryLevel: number | undefined,
  volts: number | undefined,
): boolean | undefined {
  if (batteryLevel !== undefined) {
    return batteryLevel <= LOW_BATTERY_PERCENT
  }
  if (volts !== undefined) {
    return volts <= LOW_BATTERY_VOLTS
  }
  return undefined
}
