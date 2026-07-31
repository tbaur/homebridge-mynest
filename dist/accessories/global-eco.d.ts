/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview House-wide Eco Mode switch (all Nest thermostats).
 *
 * HomeKit has no Eco thermostat mode, so Eco is a Switch. This accessory turns
 * Eco on or off for every published thermostat at once.
 */
import type { PlatformAccessory } from 'homebridge';
import type { Logger } from '../utils/logger';
import type { MyNestPlatform } from '../platform';
/** Optional Switch that drives Eco on every thermostat. */
export declare class GlobalEcoAccessory {
    #private;
    constructor(platform: MyNestPlatform, accessory: PlatformAccessory, log: Logger);
    /**
     * Reflect whether every Nest thermostat is currently in Eco.
     *
     * While a HomeKit write is pending confirmation, ignore Nest aggregates that
     * do not yet match the desired value (partial Eco reports). If Nest never
     * matches within {@link PENDING_ECO_MAX_MS}, take Nest truth.
     */
    updateAllEco(allEco: boolean): void;
}
//# sourceMappingURL=global-eco.d.ts.map