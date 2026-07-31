/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest thermostat as a HomeKit Thermostat service.
 *
 * Read-only in this version. Nest moved thermostats to its protobuf backend,
 * and on the account this plugin was developed against they do not appear in
 * the REST API at all — so the old REST write path cannot reach them, and the
 * protobuf write path has not been confirmed against a live device. Guessing
 * it would mean shipping code that changes what a house's heating is doing
 * based on an unverified payload, so the setpoint characteristics are
 * published without write handlers until that path is proven.
 */
import type { PlatformAccessory } from 'homebridge';
import type { NestDevice, ThermostatState } from '../types/device';
import type { Logger } from '../utils/logger';
import type { MyNestPlatform } from '../platform';
import { NestAccessory } from './base';
export declare class ThermostatAccessory extends NestAccessory<ThermostatState> {
    #private;
    constructor(platform: MyNestPlatform, accessory: PlatformAccessory, device: Extract<NestDevice, {
        identity: {
            kind: 'thermostat';
        };
    }>, log: Logger);
    protected bindCharacteristics(): void;
    protected onServicesMayChange(): void;
    protected describeState(): string;
}
//# sourceMappingURL=thermostat.d.ts.map