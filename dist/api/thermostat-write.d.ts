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
import type { HvacMode, ThermostatState } from '../types/device';
/** Fully qualified type URL Nest expects inside google.protobuf.Any. */
export declare const TARGET_TEMPERATURE_SETTINGS_TYPE_URL = "type.nestlabs.com/nest.trait.hvac.TargetTemperatureSettingsTrait";
/** Eco clear uses the same BatchUpdateState NestMessage as setpoints. */
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
 */
export declare function buildThermostatSetpointWrite(resourceId: string, state: ThermostatState, patch: Partial<{
    mode: HvacMode;
    targetTemperatureC: number;
    targetTemperatureLowC: number;
    targetTemperatureHighC: number;
}>): ThermostatSetpointWrite;
/** Encode a NestMessage suitable for TraitBatchApi/BatchUpdateState. */
export declare function encodeTargetTemperatureBatchUpdate(write: ThermostatSetpointWrite): Buffer;
//# sourceMappingURL=thermostat-write.d.ts.map