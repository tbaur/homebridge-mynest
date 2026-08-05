/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest Temperature Sensor as a HomeKit temperature sensor.
 *
 * These are battery-only pucks that report through whichever thermostat they
 * are paired to, so their readings arrive on both transports and can lag by a
 * few minutes. That is the device, not the plugin.
 */
import type { PlatformAccessory } from 'homebridge';
import type { NestDevice, TemperatureSensorState } from '../types/device';
import type { Logger } from '../utils/logger';
import type { MyNestPlatform } from '../platform';
import { NestAccessory } from './base';
export declare class TemperatureSensorAccessory extends NestAccessory<TemperatureSensorState> {
    #private;
    constructor(platform: MyNestPlatform, accessory: PlatformAccessory, device: Extract<NestDevice, {
        identity: {
            kind: 'temperature_sensor';
        };
    }>, log: Logger);
    protected bindCharacteristics(): void;
    protected describeState(): string;
}
