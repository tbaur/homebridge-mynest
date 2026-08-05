"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Building Nest Temperature Sensor state.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOW_BATTERY_VOLTS = exports.LOW_BATTERY_PERCENT = void 0;
exports.readTemperatureSensorState = readTemperatureSensorState;
const traits_1 = require("./traits");
/**
 * Battery percentage at or below which HomeKit is told the battery is low.
 *
 * Matches the threshold Nest itself uses to prompt for a replacement.
 */
exports.LOW_BATTERY_PERCENT = 20;
/**
 * Cell voltage at or below which the battery is treated as low.
 *
 * Only used when REST does not report a percentage. These sensors run a single
 * 3 V lithium cell whose voltage sits flat near 3.0 V for most of its life and
 * falls away at the end, so 2.6 V is late in that curve but still ahead of the
 * device going quiet.
 */
exports.LOW_BATTERY_VOLTS = 2.6;
/**
 * Build sensor state from both transports.
 *
 * Observe carries the live temperature; REST carries the battery percentage,
 * which Observe reports only as a raw cell voltage.
 */
function readTemperatureSensorState(options) {
    const { state, resourceId, kryptonite } = options;
    // Range-checked because `battery_level` means percent on a kryptonite bucket
    // but millivolts on a topaz one. Handing HomeKit a millivolt reading would
    // trip HAP's 0-100 clamp and warn on every push.
    const batteryLevel = readPercentage((0, traits_1.readNumber)(kryptonite, 'battery_level'));
    const volts = (0, traits_1.readNumber)(state.trait(resourceId, 'battery'), 'assessedVoltage', 'value');
    return {
        temperatureC: (0, traits_1.readTemperatureC)(state.trait(resourceId, 'current_temperature'))
            ?? (0, traits_1.readTemperatureC)(state.trait(resourceId, 'temperature'))
            ?? (typeof kryptonite?.current_temperature === 'number'
                && (0, traits_1.isPlausibleTemperature)(kryptonite.current_temperature)
                ? kryptonite.current_temperature
                : undefined),
        batteryLevel,
        isBatteryLow: resolveLowBattery(batteryLevel, volts),
    };
}
function readPercentage(value) {
    return value !== undefined && value >= 0 && value <= 100 ? value : undefined;
}
/** Prefer the reported percentage; fall back to voltage; otherwise say nothing. */
function resolveLowBattery(batteryLevel, volts) {
    if (batteryLevel !== undefined) {
        return batteryLevel <= exports.LOW_BATTERY_PERCENT;
    }
    if (volts !== undefined) {
        return volts <= exports.LOW_BATTERY_VOLTS;
    }
    return undefined;
}
