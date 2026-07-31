"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObserveState = void 0;
const protobuf_1 = require("../api/protobuf");
/**
 * The merged view of everything the Observe stream has said.
 *
 * Keyed by Nest resource id (`DEVICE_…`, `STRUCTURE_…`, `USER_…`).
 */
class ObserveState {
    #byResource = new Map();
    /**
     * Merge a frame's traits into the accumulated state.
     *
     * @returns The resource ids whose state actually changed. Callers use this to
     *   push only the affected accessories to HomeKit; the opening snapshot names
     *   every device, while a typical patch names one.
     */
    apply(updates) {
        const changed = new Set();
        for (const update of updates) {
            let traits = this.#byResource.get(update.resourceId);
            if (!traits) {
                traits = new Map();
                this.#byResource.set(update.resourceId, traits);
                changed.add(update.resourceId);
            }
            const record = {
                typeUrl: update.typeUrl,
                data: (0, protobuf_1.decodeTrait)(update),
                valueDigest: digestValue(update.value),
            };
            if (hasChanged(traits.get(update.key), record)) {
                changed.add(update.resourceId);
            }
            traits.set(update.key, record);
        }
        return changed;
    }
    /** Every trait known for one resource, or `undefined` if it is unknown. */
    resource(resourceId) {
        return this.#byResource.get(resourceId);
    }
    /** One decoded trait, or `undefined` when unreported or undecodable. */
    trait(resourceId, key) {
        return this.#byResource.get(resourceId)?.get(key)?.data;
    }
    /** Whether a resource has reported a given trait at all, decodable or not. */
    hasTrait(resourceId, key) {
        return this.#byResource.get(resourceId)?.has(key) ?? false;
    }
    /**
     * Drop `DEVICE_*` resources that are no longer in the merged inventory.
     *
     * Structure / user / room resources are kept — they are shared context, not
     * accessories — so only device maps are pruned.
     *
     * @returns Resource ids that were removed.
     */
    retainDeviceResources(liveResourceIds) {
        const removed = [];
        for (const resourceId of [...this.#byResource.keys()]) {
            if (!resourceId.startsWith('DEVICE_')) {
                continue;
            }
            if (!liveResourceIds.has(resourceId)) {
                this.#byResource.delete(resourceId);
                removed.push(resourceId);
            }
        }
        return removed;
    }
    /** How many `DEVICE_*` resources are currently held. */
    get deviceResourceCount() {
        let count = 0;
        for (const resourceId of this.#byResource.keys()) {
            if (resourceId.startsWith('DEVICE_')) {
                count++;
            }
        }
        return count;
    }
    get resourceIds() {
        return [...this.#byResource.keys()];
    }
    get size() {
        return this.#byResource.size;
    }
    /** Every protobuf type a resource has reported, for device classification. */
    typeUrls(resourceId) {
        const traits = this.#byResource.get(resourceId);
        if (!traits) {
            return [];
        }
        const urls = new Set();
        for (const record of traits.values()) {
            if (record.typeUrl) {
                urls.add(record.typeUrl);
            }
        }
        return [...urls];
    }
}
exports.ObserveState = ObserveState;
/**
 * Whether a trait's value differs from what was already stored.
 *
 * Prefer a digest of the undecoded wire bytes — every frame produces freshly
 * decoded objects, and JSON.stringify of Buffer-bearing payloads is O(bytes).
 * Fall back to serialized decoded data when neither side has raw bytes.
 */
function hasChanged(previous, next) {
    if (!previous) {
        return true;
    }
    if (previous.valueDigest !== undefined || next.valueDigest !== undefined) {
        return previous.valueDigest !== next.valueDigest
            || previous.typeUrl !== next.typeUrl;
    }
    return JSON.stringify(previous.data) !== JSON.stringify(next.data);
}
/** Compact fingerprint of trait payload bytes (not a cryptographic hash). */
function digestValue(value) {
    if (!value) {
        return undefined;
    }
    // FNV-1a 32-bit over the wire bytes — enough to detect Nest patches without
    // serializing decoded objects that may contain Buffer fields.
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value[i];
        hash = Math.imul(hash, 0x01000193);
    }
    return `${value.length.toString(16)}:${(hash >>> 0).toString(16)}`;
}
//# sourceMappingURL=observe-state.js.map