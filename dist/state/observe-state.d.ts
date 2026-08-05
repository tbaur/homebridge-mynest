/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Accumulated state from the Observe stream.
 *
 * Nest sends one large snapshot when a stream opens and small patches
 * thereafter. A patch carries only the traits that changed, so it must be
 * merged into what is already known — replacing state wholesale on every frame
 * would blank every trait the patch did not mention, which on a thermostat
 * means losing the current temperature every time the fan setting changes.
 */
import { type TraitUpdate } from '../api/protobuf';
/** One trait as last reported, with enough context to classify the device. */
export interface TraitRecord {
    /** Fully qualified protobuf type, used to work out what kind of device this is. */
    readonly typeUrl?: string;
    /** Decoded payload, absent when no vendored schema covers the type. */
    readonly data?: Record<string, unknown>;
    /** Hex digest of the undecoded payload bytes, for cheap change detection. */
    readonly valueDigest?: string;
}
/** Every trait a single resource has reported. */
export type ResourceTraits = ReadonlyMap<string, TraitRecord>;
/**
 * The merged view of everything the Observe stream has said.
 *
 * Keyed by Nest resource id (`DEVICE_…`, `STRUCTURE_…`, `USER_…`).
 */
/**
 * Ceiling on distinct Observe resources held at once.
 *
 * Generous next to any real home — a large account is tens of resources — so
 * reaching it means Nest is emitting identifiers this plugin does not model,
 * which is a leak rather than a house.
 */
export declare const MAX_TRACKED_RESOURCES = 2000;
export declare class ObserveState {
    #private;
    /**
     * @param onCapReached Called once if {@link MAX_TRACKED_RESOURCES} is hit, so
     *   the platform can surface it rather than silently dropping resources.
     */
    constructor(onCapReached?: (cap: number) => void);
    /**
     * Merge a frame's traits into the accumulated state.
     *
     * @returns The resource ids whose state actually changed. Callers use this to
     *   push only the affected accessories to HomeKit; the opening snapshot names
     *   every device, while a typical patch names one.
     */
    apply(updates: readonly TraitUpdate[]): ReadonlySet<string>;
    /** Every trait known for one resource, or `undefined` if it is unknown. */
    resource(resourceId: string): ResourceTraits | undefined;
    /** One decoded trait, or `undefined` when unreported or undecodable. */
    trait(resourceId: string, key: string): Record<string, unknown> | undefined;
    /** Whether a resource has reported a given trait at all, decodable or not. */
    hasTrait(resourceId: string, key: string): boolean;
    /**
     * Drop `DEVICE_*` resources that are no longer in the merged inventory.
     *
     * Structure / user / room resources are kept — they are shared context, not
     * accessories — so only device maps are pruned.
     *
     * @returns Resource ids that were removed.
     */
    retainDeviceResources(liveResourceIds: ReadonlySet<string>): readonly string[];
    /** How many `DEVICE_*` resources are currently held. */
    get deviceResourceCount(): number;
    get resourceIds(): readonly string[];
    /**
     * @internal Every resource held, devices and shared context alike. Tests
     *   only — the platform counts devices via {@link deviceResourceCount}.
     */
    get size(): number;
    /** Every protobuf type a resource has reported, for device classification. */
    typeUrls(resourceId: string): readonly string[];
}
//# sourceMappingURL=observe-state.d.ts.map