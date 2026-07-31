/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared behaviour for every accessory this plugin publishes.
 *
 * All three device types work the same way: bind each characteristic to a
 * function that reads current device state, then push everything at once when
 * new state arrives. Binding once and recomputing is what keeps live updates
 * working on Homebridge 2 — see `utils/bound-characteristics.ts` for why the
 * obvious alternatives silently stop updating.
 */
import type { PlatformAccessory, Service } from 'homebridge';
import type { DeviceIdentity, DeviceKind, NestDevice } from '../types/device';
import type { ResolvedConfig } from '../types/config';
import type { Logger } from '../utils/logger';
import { CharacteristicBinder } from '../utils/bound-characteristics';
import type { MyNestPlatform } from '../platform';
/** What the platform persists on an accessory so it survives a restart. */
export interface AccessoryContext {
    deviceId: string;
    kind: DeviceKind;
    displayName: string;
    /**
     * Non-Nest accessories (e.g. house-wide Eco switch). Skipped by Nest inventory
     * prune so they are not unregistered as "gone" devices.
     */
    synthetic?: 'global_eco';
}
/** One HomeKit accessory backed by one Nest device. */
export declare abstract class NestAccessory<TState> {
    #private;
    protected readonly platform: MyNestPlatform;
    protected readonly accessory: PlatformAccessory;
    protected readonly log: Logger;
    protected readonly config: ResolvedConfig;
    protected readonly binder: CharacteristicBinder;
    protected identity: DeviceIdentity;
    protected state: TState;
    constructor(platform: MyNestPlatform, accessory: PlatformAccessory, device: {
        identity: DeviceIdentity;
        state: TState;
    }, log: Logger);
    get deviceId(): string;
    /**
     * Take new state and push it to HomeKit.
     *
     * Called on every merged update, which on a busy home is several times a
     * minute. HAP suppresses notifications for unchanged values, so pushing
     * unconditionally is cheaper than diffing here.
     */
    update(device: NestDevice): void;
    /**
     * Bind or remove optional services when Nest state becomes available later.
     *
     * Default is a no-op. Protect occupancy and thermostat humidity use this so
     * a device that starts Observe-only can grow services once REST catches up.
     */
    protected onServicesMayChange(): void;
    /** Bind characteristics. Called once, from the concrete accessory. */
    protected abstract bindCharacteristics(): void;
    /** A one-line description of current state, for the log. */
    protected abstract describeState(): string;
    /**
     * Find an existing service or create it.
     *
     * Accessories are restored from Homebridge's cache across restarts, so a
     * service is usually already there; adding a duplicate would publish the
     * device twice in the Home app.
     */
    protected resolveService(type: typeof Service | Parameters<PlatformAccessory['getService']>[0]): Service;
    /**
     * Remove a service the user has turned off in config.
     *
     * Without this, disabling an option would leave a dead tile in the Home app
     * reporting whatever value it last held.
     */
    protected removeService(type: Parameters<PlatformAccessory['getService']>[0]): void;
}
//# sourceMappingURL=base.d.ts.map