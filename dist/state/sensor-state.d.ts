/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Building Nest Temperature Sensor state.
 */
import type { TemperatureSensorState } from '../types/device';
import type { KryptoniteBucket } from '../types/nest';
import type { ObserveState } from './observe-state';
/**
 * Battery percentage at or below which HomeKit is told the battery is low.
 *
 * Matches the threshold Nest itself uses to prompt for a replacement.
 */
export declare const LOW_BATTERY_PERCENT = 20;
/**
 * Cell voltage at or below which the battery is treated as low.
 *
 * Only used when REST does not report a percentage. These sensors run a single
 * 3 V lithium cell whose voltage sits flat near 3.0 V for most of its life and
 * falls away at the end, so 2.6 V is late in that curve but still ahead of the
 * device going quiet.
 */
export declare const LOW_BATTERY_VOLTS = 2.6;
/**
 * Build sensor state from both transports.
 *
 * Observe carries the live temperature; REST carries the battery percentage,
 * which Observe reports only as a raw cell voltage.
 */
export declare function readTemperatureSensorState(options: {
    state: ObserveState;
    resourceId: string;
    kryptonite: KryptoniteBucket | undefined;
}): TemperatureSensorState;
//# sourceMappingURL=sensor-state.d.ts.map