/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Protobuf schema loading and Observe frame decoding.
 *
 * The schemas under `assets/protobuf/` are decode-only and deliberately
 * partial: Nest publishes hundreds of traits and this plugin reads a dozen.
 * A trait with no vendored schema is skipped rather than treated as an error,
 * which is what lets the plugin keep working when Nest adds one.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import protobuf from 'protobufjs'

/** One trait reading lifted out of an Observe frame. */
export interface TraitUpdate {
  /** Resource id, e.g. `DEVICE_18B4300000ACC1AD` or `STRUCTURE_…`. */
  readonly resourceId: string
  /** Trait name in snake_case, e.g. `target_temperature_settings`. */
  readonly key: string
  /** Fully qualified protobuf type, e.g. `type.nestlabs.com/nest.trait.…`. */
  readonly typeUrl?: string
  /** Undecoded trait payload. */
  readonly value?: Buffer
}

/** Outcome of decoding one frame off the wire. */
export interface DecodedFrame {
  readonly traits: readonly TraitUpdate[]
  /** Set when Nest reported a stream-level status instead of trait data. */
  readonly status?: { code?: number, message?: string }
}

/**
 * Locate the vendored protobuf schemas.
 *
 * The path is the same two levels up from both `src/api` under ts-jest and
 * `dist/api` in the published package, so one candidate covers both. The
 * others exist so a misconfigured `files` list in package.json fails with a
 * clear message rather than an obscure protobufjs parse error.
 */
function resolveSchemaDirectory(): string {
  const candidates = [
    resolve(__dirname, '..', '..', 'assets', 'protobuf'),
    resolve(__dirname, '..', '..', '..', 'assets', 'protobuf'),
  ]

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'root.proto'))) {
      return candidate
    }
  }

  throw new Error(
    `Could not find the bundled Nest protobuf schemas. Looked in: ${candidates.join(', ')}`,
  )
}

let cachedRoot: protobuf.Root | null = null

/**
 * Load the protobuf schemas once per process.
 *
 * Loading is synchronous and happens on first use rather than at import time,
 * so a schema problem surfaces as a startup error the user can read instead of
 * a module-loading crash.
 */
export function loadSchemas(): protobuf.Root {
  cachedRoot ??= protobuf.loadSync(join(resolveSchemaDirectory(), 'root.proto'))
  return cachedRoot
}

/** The opaque request body that tells Nest which traits to stream. */
export function readObserveTraitsRequest(): Buffer {
  return readFileSync(join(resolveSchemaDirectory(), 'ObserveTraits.protobuf'))
}

/** protobufjs renders `google.protobuf.Any` fields under either spelling. */
interface AnyValue {
  type_url?: unknown
  typeUrl?: unknown
  value?: unknown
}

interface RawTraitGet {
  object?: { id?: unknown, key?: unknown }
  data?: { property?: AnyValue }
}

interface RawStreamBody {
  message?: Array<{ get?: RawTraitGet[] }>
  status?: { code?: unknown, message?: unknown }
}

/**
 * Decode one framed Observe message.
 *
 * The whole frame is passed to `StreamBody.decode`, tag byte and length prefix
 * included — see `framing.ts` for why.
 *
 * Frames that fail to decode are reported as empty rather than thrown. The
 * first frame of every connection is a resource catalogue in a different
 * shape, so a stream that threw on undecodable frames would never get past its
 * own handshake.
 */
export function decodeFrame(frame: Buffer): DecodedFrame {
  const root = loadSchemas()
  const streamBody = root.lookupType('nest.rpc.StreamBody')

  let decoded: RawStreamBody
  try {
    decoded = streamBody.decode(frame) as unknown as RawStreamBody
  } catch {
    return { traits: [] }
  }

  const traits: TraitUpdate[] = []

  for (const message of decoded.message ?? []) {
    for (const get of message.get ?? []) {
      const resourceId = get.object?.id
      const key = get.object?.key
      if (typeof resourceId !== 'string' || typeof key !== 'string') {
        continue
      }

      const property = get.data?.property
      const typeUrl = typeof property?.type_url === 'string'
        ? property.type_url
        : typeof property?.typeUrl === 'string'
          ? property.typeUrl
          : undefined
      const value = property?.value

      traits.push({
        resourceId,
        key,
        typeUrl,
        value: value instanceof Uint8Array ? Buffer.from(value) : undefined,
      })
    }
  }

  const status = decoded.status
  if (status && (status.code !== undefined || status.message !== undefined)) {
    return {
      traits,
      status: {
        code: typeof status.code === 'number' ? status.code : undefined,
        message: typeof status.message === 'string' ? status.message : undefined,
      },
    }
  }

  return { traits }
}

/** Trait type names already known to have no vendored schema. */
const unknownTypes = new Set<string>()

/**
 * Decode a trait payload into a plain object.
 *
 * @returns `undefined` when there is no vendored schema for the type or the
 *   payload does not match it. Both are expected: Nest streams every trait a
 *   device has, and this plugin reads a small subset of them.
 */
export function decodeTrait(update: TraitUpdate): Record<string, unknown> | undefined {
  if (!update.typeUrl || !update.value || update.value.length === 0) {
    return undefined
  }

  const typeName = update.typeUrl.split('/').pop()
  if (!typeName || unknownTypes.has(typeName)) {
    return undefined
  }

  const root = loadSchemas()

  let type: protobuf.Type
  try {
    type = root.lookupType(typeName)
  } catch {
    // Cached so a trait streamed on every frame does not repeat the lookup and
    // the exception it throws for the lifetime of the process.
    unknownTypes.add(typeName)
    return undefined
  }

  try {
    return type.toObject(type.decode(update.value), {
      enums: String,
      longs: String,
      defaults: false,
    })
  } catch {
    return undefined
  }
}
