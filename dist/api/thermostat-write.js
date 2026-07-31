"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Encode Nest BatchUpdateState bodies for thermostat setpoints.
 *
 * Modern Nest thermostats are Observe-only; REST `/v5/put` cannot reach them.
 * Writes go to `TraitBatchApi/BatchUpdateState` as a `nest.rpc.NestMessage`
 * whose `set` entries carry encoded trait bytes. The encode shape matches the
 * Nest web app / community protobuf path and probe 12 dry-runs; enable
 * `allowThermostatControl` only after a live `--confirm` on your account.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ECO_MODE_STATE_TYPE_URL = exports.TARGET_TEMPERATURE_SETTINGS_TYPE_URL = void 0;
exports.buildThermostatSetpointWrite = buildThermostatSetpointWrite;
exports.encodeTargetTemperatureBatchUpdate = encodeTargetTemperatureBatchUpdate;
const node_crypto_1 = require("node:crypto");
const settings_1 = require("../settings");
const protobuf_1 = require("./protobuf");
/** Fully qualified type URL Nest expects inside google.protobuf.Any. */
exports.TARGET_TEMPERATURE_SETTINGS_TYPE_URL = 'type.nestlabs.com/nest.trait.hvac.TargetTemperatureSettingsTrait';
/** Eco clear uses the same BatchUpdateState NestMessage as setpoints. */
exports.ECO_MODE_STATE_TYPE_URL = 'type.nestlabs.com/nest.trait.hvac.EcoModeStateTrait';
/**
 * Merge a HomeKit-driven patch onto the last Nest thermostat state.
 *
 * Always produces both heat and cool floats: Nest's trait carries the pair
 * even on heat-only equipment, and omitting one can bounce the other bound.
 */
function buildThermostatSetpointWrite(resourceId, state, patch) {
    const mode = patch.mode ?? state.mode ?? 'heat';
    const standbyMode = resolveStandbyMode(state, patch.mode);
    let heat = state.targetTemperatureLowC
        ?? state.targetTemperatureC
        ?? 20;
    let cool = state.targetTemperatureHighC
        ?? (state.mode === 'cool' ? state.targetTemperatureC : undefined)
        ?? heat + 5;
    if (patch.targetTemperatureLowC !== undefined) {
        heat = patch.targetTemperatureLowC;
    }
    if (patch.targetTemperatureHighC !== undefined) {
        cool = patch.targetTemperatureHighC;
    }
    if (patch.targetTemperatureC !== undefined) {
        const effective = patch.mode ?? state.mode ?? 'heat';
        if (effective === 'cool') {
            cool = patch.targetTemperatureC;
        }
        else if (effective === 'range') {
            const span = Math.max(cool - heat, 2);
            heat = patch.targetTemperatureC - span / 2;
            cool = patch.targetTemperatureC + span / 2;
        }
        else {
            heat = patch.targetTemperatureC;
        }
    }
    if (cool < heat) {
        cool = heat + 2;
    }
    return {
        resourceId,
        mode,
        targetTemperatureHeatC: clampSetpoint(heat),
        targetTemperatureCoolC: clampSetpoint(cool),
        standbyMode,
        clearEco: state.isEcoActive === true,
    };
}
/** Encode a NestMessage suitable for TraitBatchApi/BatchUpdateState. */
function encodeTargetTemperatureBatchUpdate(write) {
    const root = (0, protobuf_1.loadSchemas)();
    const setpointTrait = root.lookupType('nest.trait.hvac.TargetTemperatureSettingsTrait');
    const ecoTrait = root.lookupType('nest.trait.hvac.EcoModeStateTrait');
    const NestMessage = root.lookupType('nest.rpc.NestMessage');
    const isOff = write.mode === 'off';
    const hvacMode = (isOff ? write.standbyMode : write.mode).toUpperCase();
    const nowSec = Math.floor(Date.now() / 1000);
    const updateInfo = {
        updateSource: 'DEVICE',
        updatedBy: { value: write.resourceId },
        timestamp: { value: nowSec },
    };
    const setpointObject = {
        settings: {
            hvacMode,
            targetTemperatureHeat: { value: write.targetTemperatureHeatC },
            targetTemperatureCool: { value: write.targetTemperatureCoolC },
            updateInfo,
            originalUpdateInfo: { updatedBy: {}, timestamp: {} },
        },
        active: { value: isOff ? 0 : 1 },
    };
    /** @type {Array<{ object: object, property: object }>} */
    const set = [];
    // Clear Eco first so a manual Home change is not overridden by Eco hold.
    if (write.clearEco) {
        const ecoBytes = ecoTrait.encode(ecoTrait.fromObject({
            ecoEnabled: 'OFF',
            ecoModeChangeReason: 'ECO_MODE_CHANGE_REASON_MANUAL',
            updateInfo,
        })).finish();
        set.push({
            object: {
                id: write.resourceId,
                key: 'eco_mode_state',
                uuid: (0, node_crypto_1.randomUUID)(),
            },
            property: {
                type_url: exports.ECO_MODE_STATE_TYPE_URL,
                value: ecoBytes,
            },
        });
    }
    set.push({
        object: {
            id: write.resourceId,
            key: 'target_temperature_settings',
            uuid: (0, node_crypto_1.randomUUID)(),
        },
        property: {
            type_url: exports.TARGET_TEMPERATURE_SETTINGS_TYPE_URL,
            value: setpointTrait.encode(setpointTrait.fromObject(setpointObject)).finish(),
        },
    });
    return Buffer.from(NestMessage.encode(NestMessage.fromObject({ set })).finish());
}
/**
 * Mode Nest retains in `settings.hvacMode` while `active=0`.
 *
 * Prefer the mode we are leaving, then Nest's last reported hvacMode, then
 * equipment capability. Never invent HEAT on a cool-standby dual system.
 */
function resolveStandbyMode(state, patchMode) {
    if (patchMode === 'off' && state.mode && state.mode !== 'off') {
        return state.mode;
    }
    if (state.lastHvacMode) {
        return state.lastHvacMode;
    }
    if (state.mode && state.mode !== 'off') {
        return state.mode;
    }
    return state.canCool && !state.canHeat ? 'cool' : 'heat';
}
function clampSetpoint(celsius) {
    return Math.min(settings_1.MAX_SETPOINT_C, Math.max(settings_1.MIN_SETPOINT_C, celsius));
}
//# sourceMappingURL=thermostat-write.js.map