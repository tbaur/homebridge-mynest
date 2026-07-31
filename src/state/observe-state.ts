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

import { decodeTrait, type TraitUpdate } from '../api/protobuf'

/** One trait as last reported, with enough context to classify the device. */
export interface TraitRecord {
  /** Fully qualified protobuf type, used to work out what kind of device this is. */
  readonly typeUrl?: string
  /** Decoded payload, absent when no vendored schema covers the type. */
  readonly data?: Record<string, unknown>
  /** Hex digest of the undecoded payload bytes, for cheap change detection. */
  readonly valueDigest?: string
}

/** Every trait a single resource has reported. */
export type ResourceTraits = ReadonlyMap<string, TraitRecord>

/**
 * The merged view of everything the Observe stream has said.
 *
 * Keyed by Nest resource id (`DEVICE_…`, `STRUCTURE_…`, `USER_…`).
 */
export class ObserveState {
  readonly #byResource = new Map<string, Map<string, TraitRecord>>()

  /**
   * Merge a frame's traits into the accumulated state.
   *
   * @returns The resource ids whose state actually changed. Callers use this to
   *   push only the affected accessories to HomeKit; the opening snapshot names
   *   every device, while a typical patch names one.
   */
  apply(updates: readonly TraitUpdate[]): ReadonlySet<string> {
    const changed = new Set<string>()

    for (const update of updates) {
      let traits = this.#byResource.get(update.resourceId)
      if (!traits) {
        traits = new Map()
        this.#byResource.set(update.resourceId, traits)
        changed.add(update.resourceId)
      }

      const record: TraitRecord = {
        typeUrl: update.typeUrl,
        data: decodeTrait(update),
        valueDigest: digestValue(update.value),
      }

      if (hasChanged(traits.get(update.key), record)) {
        changed.add(update.resourceId)
      }

      traits.set(update.key, record)
    }

    return changed
  }

  /** Every trait known for one resource, or `undefined` if it is unknown. */
  resource(resourceId: string): ResourceTraits | undefined {
    return this.#byResource.get(resourceId)
  }

  /** One decoded trait, or `undefined` when unreported or undecodable. */
  trait(resourceId: string, key: string): Record<string, unknown> | undefined {
    return this.#byResource.get(resourceId)?.get(key)?.data
  }

  /** Whether a resource has reported a given trait at all, decodable or not. */
  hasTrait(resourceId: string, key: string): boolean {
    return this.#byResource.get(resourceId)?.has(key) ?? false
  }

  /**
   * Drop `DEVICE_*` resources that are no longer in the merged inventory.
   *
   * Structure / user / room resources are kept — they are shared context, not
   * accessories — so only device maps are pruned.
   *
   * @returns Resource ids that were removed.
   */
  retainDeviceResources(liveResourceIds: ReadonlySet<string>): readonly string[] {
    const removed: string[] = []
    for (const resourceId of [...this.#byResource.keys()]) {
      if (!resourceId.startsWith('DEVICE_')) {
        continue
      }
      if (!liveResourceIds.has(resourceId)) {
        this.#byResource.delete(resourceId)
        removed.push(resourceId)
      }
    }
    return removed
  }

  /** How many `DEVICE_*` resources are currently held. */
  get deviceResourceCount(): number {
    let count = 0
    for (const resourceId of this.#byResource.keys()) {
      if (resourceId.startsWith('DEVICE_')) {
        count++
      }
    }
    return count
  }

  get resourceIds(): readonly string[] {
    return [...this.#byResource.keys()]
  }

  get size(): number {
    return this.#byResource.size
  }

  /** Every protobuf type a resource has reported, for device classification. */
  typeUrls(resourceId: string): readonly string[] {
    const traits = this.#byResource.get(resourceId)
    if (!traits) {
      return []
    }

    const urls = new Set<string>()
    for (const record of traits.values()) {
      if (record.typeUrl) {
        urls.add(record.typeUrl)
      }
    }
    return [...urls]
  }
}

/**
 * Whether a trait's value differs from what was already stored.
 *
 * Prefer a digest of the undecoded wire bytes — every frame produces freshly
 * decoded objects, and JSON.stringify of Buffer-bearing payloads is O(bytes).
 * Fall back to serialized decoded data when neither side has raw bytes.
 */
function hasChanged(previous: TraitRecord | undefined, next: TraitRecord): boolean {
  if (!previous) {
    return true
  }
  if (previous.valueDigest !== undefined || next.valueDigest !== undefined) {
    return previous.valueDigest !== next.valueDigest
      || previous.typeUrl !== next.typeUrl
  }
  return JSON.stringify(previous.data) !== JSON.stringify(next.data)
}

/** Compact fingerprint of trait payload bytes (not a cryptographic hash). */
function digestValue(value: Buffer | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  // FNV-1a 32-bit over the wire bytes — enough to detect Nest patches without
  // serializing decoded objects that may contain Buffer fields.
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value[i]!
    hash = Math.imul(hash, 0x01000193)
  }
  return `${value.length.toString(16)}:${(hash >>> 0).toString(16)}`
}
