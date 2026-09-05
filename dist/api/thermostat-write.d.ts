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
 * whose `set` entries carry encoded trait bytes. The encode shape was
 * established against a live account with a maintainer-only probe kit that is
 * not part of this repository, so a change here cannot be validated by the unit
 * tests alone. `allowThermostatControl` is off by default for that reason.
 */
import type { HvacMode, ThermostatState } from '../types/device';
/** Fully qualified type URL Nest expects inside google.protobuf.Any. */
export declare const TARGET_TEMPERATURE_SETTINGS_TYPE_URL = "type.nestlabs.com/nest.trait.hvac.TargetTemperatureSettingsTrait";
/** Eco set and clear use the same BatchUpdateState NestMessage as setpoints. */
export declare const ECO_MODE_STATE_TYPE_URL = "type.nestlabs.com/nest.trait.hvac.EcoModeStateTrait";
/** One setpoint / mode change ready to encode. */
export interface ThermostatSetpointWrite {
    /** Observe resource id, e.g. `DEVICE_641666…`. */
    readonly resourceId: string;
    /** Desired HomeKit-facing mode (`off` clears `active`). */
    readonly mode: HvacMode;
    readonly targetTemperatureHeatC: number;
    readonly targetTemperatureCoolC: number;
    /**
     * Mode Nest keeps in `settings.hvacMode` while the unit is off.
     * Nest never stores OFF there — only `active=0`. May be `range`.
     */
    readonly standbyMode: Exclude<HvacMode, 'off'>;
    /**
     * When true, also clear Nest Eco (`eco_mode_state` → OFF) in the same
     * BatchUpdateState. Manual HomeKit changes should leave Eco like the Nest app.
     */
    readonly clearEco: boolean;
}
/**
 * Merge a HomeKit-driven patch onto the last Nest thermostat state.
 *
 * Always produces both heat and cool floats: Nest's trait carries the pair
 * even on heat-only equipment, and omitting one can bounce the other bound.
 *
 * The bound the user actually moved is authoritative. When honouring it would
 * cross the other bound, the *untouched* one yields — sending a value the user
 * did not ask for is worse than moving a bound they were not looking at, and
 * the Home app shows their requested number either way.
 */
export declare function buildThermostatSetpointWrite(resourceId: string, state: ThermostatState, patch: Partial<{
    mode: HvacMode;
    targetTemperatureC: number;
    targetTemperatureLowC: number;
    targetTemperatureHighC: number;
}>): ThermostatSetpointWrite;
/**
 * Homebridge info line for a successful HomeKit-driven Nest write.
 *
 * Mode-aware so heat updates do not dump the unused cool bound Nest still
 * carries in the trait.
 */
export declare function formatThermostatUpdateLog(write: ThermostatSetpointWrite): string;
/** Encode Eco on/off for TraitBatchApi/BatchUpdateState (no setpoint change). */
export declare function encodeEcoModeBatchUpdate(resourceId: string, ecoOn: boolean): Buffer;
/** Encode a NestMessage suitable for TraitBatchApi/BatchUpdateState. */
export declare function encodeTargetTemperatureBatchUpdate(write: ThermostatSetpointWrite): Buffer;
/**
 * Confine a Celsius setpoint to the range Nest accepts.
 *
 * Exported because the accessory's publish path needs the same bounds: the
 * range HomeKit is told about and the range a write is clamped to must come
 * from one place, or a value the plugin publishes can be one it would refuse
 * to send back.
 */
export declare function clampSetpoint(celsius: number): number;
