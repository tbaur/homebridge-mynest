"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Building thermostat state from Observe traits and REST buckets.
 *
 * Observe is authoritative here. On an account whose thermostats have moved to
 * the protobuf backend — which is now the common case — REST reports no
 * thermostat buckets at all while still claiming the home has five of them.
 * The REST path below exists for older accounts that do return them.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.readComfortSource = readComfortSource;
exports.readThermostatFromObserve = readThermostatFromObserve;
exports.readThermostatFromRest = readThermostatFromRest;
exports.mergeThermostatState = mergeThermostatState;
const traits_1 = require("./traits");
/**
 * Which sensor the thermostat is regulating to.
 *
 * A Nest thermostat paired with Temperature Sensors regulates to the selected
 * sensor, and the Nest app shows that sensor's reading as the current
 * temperature. Publishing the thermostat's own backplate reading instead makes
 * the Home app disagree with the Nest app by several degrees, which reads as a
 * bug even though both numbers are real.
 */
function readComfortSource(state, resourceId) {
    const settings = state.trait(resourceId, 'remote_comfort_sensing_settings');
    const sourceType = (0, traits_1.readEnum)(settings, 'activeRcsSelection', 'rcsSourceType');
    if (sourceType !== 'RCS_SOURCE_TYPE_SINGLE_SENSOR') {
        return {};
    }
    const sensorResourceId = (0, traits_1.readString)(settings, 'activeRcsSelection', 'activeRcsSensor', 'resourceId');
    return sensorResourceId ? { sensorResourceId } : {};
}
/**
 * Read the thermostat's own temperature.
 *
 * `backplate_temperature` is the thermostat's physical sensor and is the trait
 * that is actually populated; the generic `temperature` trait is advertised on
 * these devices but arrives empty, so it is only a fallback.
 */
function readOwnTemperature(state, resourceId) {
    return (0, traits_1.readTemperatureC)(state.trait(resourceId, 'backplate_temperature'))
        ?? (0, traits_1.readTemperatureC)(state.trait(resourceId, 'temperature'));
}
/** Nest's retained `settings.hvacMode` (never OFF — that is `active=0`). */
function readLastHvacMode(settings) {
    if (!settings) {
        return undefined;
    }
    switch ((0, traits_1.readEnum)(settings, 'settings', 'hvacMode')) {
        case 'HEAT':
            return 'heat';
        case 'COOL':
            return 'cool';
        case 'RANGE':
            return 'range';
        default:
            return undefined;
    }
}
/**
 * Map Nest's setpoint mode onto {@link HvacMode}.
 *
 * Nest does not encode "off" in `hvacMode`. It signals it by clearing the
 * `active` flag on the setpoint while leaving the last mode in place, so a
 * thermostat switched off still reports `HEAT`. Reading `hvacMode` alone
 * therefore shows every off thermostat as heating.
 */
function readMode(settings) {
    if (!settings) {
        return undefined;
    }
    // proto3 omits a field at its default, so an on thermostat sends
    // `active: { value: 1 }` and an off one sends `active: {}` or nothing at all.
    // Absent has to be read as off; treating it as unknown and falling through to
    // `hvacMode` shows every switched-off thermostat as heating, because Nest
    // leaves the last mode in place.
    if ((0, traits_1.readIntFlag)(settings, 'active', 'value') !== true) {
        return 'off';
    }
    return readLastHvacMode(settings);
}
/** What the equipment is doing, from the relay states Nest reports. */
function readActivity(control) {
    if (!control) {
        return undefined;
    }
    // proto3 omits zeroes, so an idle system sends an empty `settings` message.
    // Absent means off, which is why these are read as flags rather than
    // required fields.
    if ((0, traits_1.readIntFlag)(control, 'settings', 'isHeating') === true) {
        return 'heating';
    }
    if ((0, traits_1.readIntFlag)(control, 'settings', 'isCooling') === true) {
        return 'cooling';
    }
    return 'idle';
}
/** Build thermostat state from the Observe stream. */
function readThermostatFromObserve(state, resourceId, options = {}) {
    const setpoints = state.trait(resourceId, 'target_temperature_settings');
    const capabilities = state.trait(resourceId, 'hvac_equipment_capabilities');
    const mode = readMode(setpoints);
    const heatSetpoint = (0, traits_1.readIndirectFloat)(setpoints, 'settings', 'targetTemperatureHeat');
    const coolSetpoint = (0, traits_1.readIndirectFloat)(setpoints, 'settings', 'targetTemperatureCool');
    const lastHvacMode = readLastHvacMode(setpoints);
    return {
        currentTemperatureC: options.comfortTemperatureC ?? readOwnTemperature(state, resourceId),
        currentHumidity: (0, traits_1.readHumidity)(state.trait(resourceId, 'humidity')),
        mode,
        lastHvacMode,
        activity: readActivity(state.trait(resourceId, 'hvac_control')),
        // In `range` mode Nest carries both bounds and no single setpoint, so the
        // single value is only meaningful for the mode that is actually in use.
        // A switched-off unit reports `off`, with the real mode in `lastHvacMode` —
        // resolving through it stops a cool-only thermostat showing (and later
        // writing) its unused heat bound.
        targetTemperatureC: (mode === 'off' ? lastHvacMode : mode) === 'cool'
            ? coolSetpoint
            : heatSetpoint,
        targetTemperatureLowC: heatSetpoint,
        targetTemperatureHighC: coolSetpoint,
        isEcoActive: readEcoActive(state, resourceId),
        // Read within the trait rather than through it: a heat-only thermostat
        // reports `{ canHeat: 1 }` and omits `canCool` entirely, so once the trait
        // itself has arrived an absent flag is a definite "no", not "unknown".
        // Left `undefined` while the trait is missing so HomeKit is not told a
        // thermostat has no equipment at all before its capabilities arrive.
        canHeat: capabilities ? (0, traits_1.readIntFlag)(capabilities, 'canHeat') ?? false : undefined,
        canCool: capabilities ? (0, traits_1.readIntFlag)(capabilities, 'canCool') ?? false : undefined,
        displayUnit: (0, traits_1.readEnum)(state.trait(resourceId, 'display_settings'), 'units') === 'DEGREES_F'
            ? 'F'
            : 'C',
    };
}
function readEcoActive(state, resourceId) {
    const eco = (0, traits_1.readEnum)(state.trait(resourceId, 'eco_mode_state'), 'ecoEnabled');
    if (eco === 'ON') {
        return true;
    }
    if (eco === 'OFF') {
        return false;
    }
    return undefined;
}
/**
 * Build thermostat state from the legacy REST buckets.
 *
 * Used only for accounts that still report `device` and `shared` buckets. The
 * shapes are simpler here because REST already flattens Nest's indirection.
 */
function readThermostatFromRest(shared, device) {
    return {
        currentTemperatureC: (0, traits_1.readNumber)(shared, 'current_temperature'),
        currentHumidity: (0, traits_1.readNumber)(device, 'current_humidity'),
        mode: readRestMode(shared?.target_temperature_type),
        activity: shared?.hvac_heater_state === true
            ? 'heating'
            : shared?.hvac_ac_state === true
                ? 'cooling'
                : shared
                    ? 'idle'
                    : undefined,
        targetTemperatureC: (0, traits_1.readNumber)(shared, 'target_temperature'),
        targetTemperatureLowC: (0, traits_1.readNumber)(shared, 'target_temperature_low'),
        targetTemperatureHighC: (0, traits_1.readNumber)(shared, 'target_temperature_high'),
        canHeat: typeof shared?.can_heat === 'boolean' ? shared.can_heat : undefined,
        canCool: typeof shared?.can_cool === 'boolean' ? shared.can_cool : undefined,
    };
}
function readRestMode(value) {
    switch (value) {
        case 'off':
        case 'heat':
        case 'cool':
        case 'range':
            return value;
        default:
            return undefined;
    }
}
/**
 * Combine both transports, letting whichever reported a field win.
 *
 * Observe takes precedence because it is the live push channel; REST fills
 * gaps rather than overriding. Merging field by field rather than picking one
 * source means a home with a mix of old and new thermostats works without a
 * special case.
 */
function mergeThermostatState(observe, rest) {
    return {
        currentTemperatureC: observe?.currentTemperatureC ?? rest?.currentTemperatureC,
        currentHumidity: observe?.currentHumidity ?? rest?.currentHumidity,
        mode: observe?.mode ?? rest?.mode,
        activity: observe?.activity ?? rest?.activity,
        targetTemperatureC: observe?.targetTemperatureC ?? rest?.targetTemperatureC,
        targetTemperatureLowC: observe?.targetTemperatureLowC ?? rest?.targetTemperatureLowC,
        targetTemperatureHighC: observe?.targetTemperatureHighC ?? rest?.targetTemperatureHighC,
        canHeat: observe?.canHeat ?? rest?.canHeat,
        canCool: observe?.canCool ?? rest?.canCool,
        // Observe-only fields: `readThermostatFromRest` never sets these, so a
        // `?? rest?.…` fallback would be an unreachable branch implying the legacy
        // buckets carry data they do not.
        lastHvacMode: observe?.lastHvacMode,
        isEcoActive: observe?.isEcoActive,
        displayUnit: observe?.displayUnit,
    };
}
//# sourceMappingURL=thermostat-state.js.map