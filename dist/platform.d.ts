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
export declare class MyNestPlatform implements DynamicPlatformPlugin {
    #private;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly api: API;
    constructor(log: Logging, config: PlatformConfig, api: API);
    get resolvedConfig(): ResolvedConfig;
    /** Homebridge replays cached accessories here before `didFinishLaunching`. */
    configureAccessory(accessory: PlatformAccessory): void;
}
//# sourceMappingURL=platform.d.ts.map