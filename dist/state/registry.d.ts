/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The union of what both transports report about the home.
 *
 * Neither Nest API is a superset of the other. On the account this plugin was
 * built against, REST `app_launch` returned six Protects and no thermostats
 * while the Observe stream returned seven Protects and five thermostats — and
 * REST simultaneously claimed `num_thermostats: "5+"`. Trusting either alone
 * loses devices, so the registry unions them and records which one supplied
 * each device.
 */
import type { DeviceInventory, NestDevice } from '../types/device';
import type { BucketMap } from '../types/nest';
import type { ObserveState } from './observe-state';
export interface BuildInventoryOptions {
    observe: ObserveState;
    buckets: BucketMap;
    /** Device ids the user asked to keep out of HomeKit, already normalised. */
    ignoredDeviceIds: ReadonlySet<string>;
    /**
     * When false, Protect smoke/CO and REST occupancy are marked stale (kept in
     * HomeKit but faulted/inactive) even if cached topaz still holds last-known
     * values. Defaults to true.
     */
    restAlarmFeedAvailable?: boolean;
}
/**
 * Merge both transports into the device list the platform publishes.
 *
 * Pure: it reads the two state stores and returns a new inventory, so it can
 * be exercised against fixtures without any transport.
 */
export declare function buildInventory(options: BuildInventoryOptions): DeviceInventory;
/** Every device in an inventory, in a stable order, for logging and iteration. */
export declare function listDevices(inventory: DeviceInventory): NestDevice[];
