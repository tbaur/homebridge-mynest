/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest thermostat as a HomeKit Thermostat service.
 *
 * Mode and setpoints write through Nest `BatchUpdateState` when
 * `allowThermostatControl` is enabled. Target characteristics keep write
 * permissions either way — stripping them makes the Home app show
 * "No Response" and hide room tiles.
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