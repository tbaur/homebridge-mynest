/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Working out what a Nest resource is and what to call it.
 *
 * Nest's Observe stream never states a device's type. It streams whatever
 * traits the hardware supports, so the type has to be inferred from which
 * traits are present. That is less fragile than it sounds: a Protect is the
 * only thing that carries `nest.trait.product.protect.*`, and a thermostat the
 * only thing that carries `hvac.HvacControlTrait`.
 */
import type { DeviceKind } from '../types/device';
import type { ObserveState } from './observe-state';
/** Prefix Nest puts on every device resource id on the Observe stream. */
export declare const OBSERVE_DEVICE_PREFIX = "DEVICE_";
/**
 * Reduce an Observe resource id to the id the REST buckets use.
 *
 * Confirmed on a live account: Observe reports `DEVICE_18B4300000ACC1AD` for
 * the same Protect that REST reports as `topaz.18B4300000ACC1AD`. This exact
 * correspondence is what makes merging the two transports possible at all.
 */
export declare function toDeviceId(resourceId: string): string;
/** Expand a REST bucket id into the Observe resource id for the same device. */
export declare function toResourceId(deviceId: string): string;
/**
 * Identify a device from the protobuf types it reports.
 *
 * Order matters. A Protect carries `sensor.TemperatureTrait` too, so the
 * temperature-sensor test has to come after the Protect and thermostat tests
 * or every Protect in the house is published as a thermometer.
 */
export declare function classifyResource(resourceId: string, typeUrls: readonly string[]): DeviceKind | undefined;
/** A room id to room name mapping, from either transport. */
export type RoomNames = ReadonlyMap<string, string>;
/**
 * Collect every room name the Observe stream has reported.
 *
 * The annotation list is duplicated onto the structure and onto each
 * thermostat, so it is gathered from every resource that carries it rather
 * than from one assumed location.
 */
export declare function collectObserveRoomNames(state: ObserveState): RoomNames;
/**
 * Choose the name to publish to HomeKit.
 *
 * Preference order is deliberate: a name the user typed beats a room name, and
 * a room name beats anything derived from an id. The final fallback includes
 * the tail of the hardware id so two unnamed devices of the same kind are
 * still distinguishable in the Home app.
 */
export declare function resolveDeviceName(options: {
    kind: DeviceKind;
    deviceId: string;
    /** User-assigned label from Observe's `label` trait. */
    label?: string;
    /** User-assigned description from a REST bucket. */
    description?: string;
    /** Room name, already resolved from whichever transport supplied it. */
    roomName?: string;
}): string;
//# sourceMappingURL=classify.d.ts.map