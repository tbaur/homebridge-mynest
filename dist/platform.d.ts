/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The Homebridge platform: discovery, state, and the update path.
 *
 * The platform owns the merged view of the home. Both transports hand it raw
 * updates, it folds them into the two state stores, rebuilds the inventory, and
 * pushes the result to accessories. Devices are published from the union of
 * both transports, because on a real account neither one sees the whole house.
 */
import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import type { ResolvedConfig } from './types/config';
import { type HvacMode, type ThermostatState } from './types/device';
import { type ThermostatSetpointWrite } from './api/thermostat-write';
export declare class MyNestPlatform implements DynamicPlatformPlugin {
    #private;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly api: API;
    constructor(log: Logging, config: PlatformConfig, api: API);
    get resolvedConfig(): ResolvedConfig;
    /** Homebridge replays cached accessories here before `didFinishLaunching`. */
    configureAccessory(accessory: PlatformAccessory): void;
    /**
     * Apply a HomeKit-originated thermostat change via Nest BatchUpdateState.
     *
     * No-ops when control is disabled so characteristics can stay writable for
     * HomeKit presentation without guessing at HVAC writes. The accessory logs
     * the user-facing success / ignore line.
     *
     * @returns The write that was sent, or `null` when control is off.
     */
    applyThermostatWrite(deviceId: string, state: ThermostatState, patch: Partial<{
        mode: HvacMode;
        targetTemperatureC: number;
        targetTemperatureLowC: number;
        targetTemperatureHighC: number;
    }>): Promise<ThermostatSetpointWrite | null>;
    /**
     * Set Eco on one thermostat via Nest BatchUpdateState.
     *
     * @returns `true` when a Nest write was sent; `false` when control is off.
     */
    applyEcoWrite(deviceId: string, ecoOn: boolean): Promise<boolean>;
    /**
     * Set Eco on every published Nest thermostat.
     *
     * @returns `true` only when every targeted thermostat accepted the write.
     *   `false` when control is off, there are no thermostats, or any write failed
     *   (partial failures are logged; HomeKit must not flip the global switch).
     */
    applyGlobalEcoWrite(ecoOn: boolean): Promise<boolean>;
}
