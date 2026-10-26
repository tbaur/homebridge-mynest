/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest Protect as smoke, CO, and optional occupancy sensors.
 *
 * The occupancy sensor here is the part worth reading carefully. A Protect has
 * a PIR sensor, but neither Nest API publishes motion events: a 12.5-hour
 * capture of both transports on an occupied house recorded zero motion events
 * and zero occupancy changes. What is available is `auto_away`, Nest's own
 * verdict that nobody has been seen for roughly ten minutes, and omitted for
 * a battery-powered Protect. Unknown power does not hide a boolean `auto_away`.
 *
 * So this accessory publishes occupancy only where that verdict exists, and
 * says why in the log when it does not. Presenting a ten-minute presence
 * signal as motion would be the easy thing to do and would make every
 * automation built on it wrong.
 *
 * Smoke and CO come from REST `topaz` only. Observe streams safety traits, but
 * no public schema maps them and every captured sample reads all-clear, so
 * those fields are not read. Every Protect still publishes both sensors. A
 * missing number faults the sensor and does not write a clear. When REST later
 * goes stale, tiles stay published (so HomeKit rooms and automations survive)
 * but are marked inactive and faulted. See `docs/PROTOCOL.md`.
 */
import type { PlatformAccessory } from 'homebridge';
import type { NestDevice, ProtectState } from '../types/device';
import type { Logger } from '../utils/logger';
import type { MyNestPlatform } from '../platform';
import { NestAccessory } from './base';
export declare class ProtectAccessory extends NestAccessory<ProtectState> {
    #private;
    /** @internal Clears the process-wide occupancy hint flag (tests only). */
    static resetOccupancyHintForTests(): void;
    constructor(platform: MyNestPlatform, accessory: PlatformAccessory, device: Extract<NestDevice, {
        identity: {
            kind: 'protect';
        };
    }>, log: Logger);
    protected bindCharacteristics(): void;
    protected onServicesMayChange(): void;
    protected describeState(): string;
}
