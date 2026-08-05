/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Protobuf schema loading and Observe frame decoding.
 *
 * The schemas under `assets/protobuf/` are deliberately partial: Nest publishes
 * hundreds of traits and this plugin reads a dozen (and encodes thermostat
 * setpoint writes).
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
  /**
   * True when the frame did not parse as a `StreamBody` at all.
   *
   * Reported rather than swallowed because it is the difference between the
   * routine case (frame 0 of every connection is a catalogue in another shape)
   * and the catastrophic one (Nest changed the trait schema, so *every* frame
   * decodes to nothing while the frame counter keeps climbing and health stays
   * green). Callers watch the ratio.
   */
  readonly isUndecodable?: boolean
}

/**
 * Locate the vendored protobuf schemas.
 *
 * The path is the same two levels up from both `src/api` under ts-jest and
 * `dist/api` in the published package, so one candidate covers both. The
 * others exist so a misconfigured `files` list in package.json fails with a
 * clear message rather than an obscure protobufjs parse error.
 */
let cachedSchemaDirectory: string | null = null

function resolveSchemaDirectory(): string {
  if (cachedSchemaDirectory !== null) {
    return cachedSchemaDirectory
  }

  // One candidate only. The path is the same two levels up from both `src/api`
  // under ts-jest and `dist/api` in the published package. A `../../..` fallback
  // resolves to `node_modules/assets/protobuf` for an installed package — outside
  // this package entirely — so a broken install would silently load wire-format
  // schemas that any other package's postinstall could have planted, and those
  // schemas decide how remote bytes become device state.
  const candidate = resolve(__dirname, '..', '..', 'assets', 'protobuf')
  if (existsSync(join(candidate, 'root.proto'))) {
    cachedSchemaDirectory = candidate
    return candidate
  }

  throw new Error(
    `Could not find the bundled Nest protobuf schemas. Looked in: ${candidate}`,
  )
}

let cachedRoot: protobuf.Root | null = null
let cachedTraitsRequest: Buffer | null = null

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

/**
 * The opaque request body that tells Nest which traits to stream.
 *
 * Read once. This is called on every Observe connection, and reconnects can
 * come every few seconds during an outage — synchronous filesystem IO on the
 * event loop at that cadence stalls every plugin in the process.
 */
export function readObserveTraitsRequest(): Buffer {
  cachedTraitsRequest ??= readFileSync(join(resolveSchemaDirectory(), 'ObserveTraits.protobuf'))
  return cachedTraitsRequest
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
  const streamBody = lookupCachedType('nest.rpc.StreamBody')
  if (!streamBody) {
    return { traits: [], isUndecodable: true }
  }

  let decoded: RawStreamBody
  try {
    decoded = streamBody.decode(frame) as unknown as RawStreamBody
  } catch {
    return { traits: [], isUndecodable: true }
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

/**
 * Trait type names already known to have no vendored schema.
 *
 * Bounded: the names come from Nest, so an unbounded set is a slow leak driven
 * by remote input. Past the cap the lookup simply repeats, which costs a little
 * time rather than memory that is never reclaimed.
 */
const MAX_UNKNOWN_TYPES = 512
const unknownTypes = new Set<string>()

/**
 * Resolved protobuf types, memoized.
 *
 * `lookupType` splits the name and walks the namespace on every call, and the
 * opening snapshot alone is hundreds of traits — the negative results were
 * already cached, but the successful ones were re-resolved per frame.
 */
const resolvedTypes = new Map<string, protobuf.Type>()

/** Resolve a protobuf type once, or `undefined` when no schema covers it. */
function lookupCachedType(typeName: string): protobuf.Type | undefined {
  const cached = resolvedTypes.get(typeName)
  if (cached) {
    return cached
  }
  if (unknownTypes.has(typeName)) {
    return undefined
  }

  try {
    const type = loadSchemas().lookupType(typeName)
    if (resolvedTypes.size < MAX_UNKNOWN_TYPES) {
      resolvedTypes.set(typeName, type)
    }
    return type
  } catch {
    if (unknownTypes.size < MAX_UNKNOWN_TYPES) {
      unknownTypes.add(typeName)
    }
    return undefined
  }
}

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
  if (!typeName) {
    return undefined
  }

  // Memoized both ways: a trait streamed on every frame neither repeats the
  // namespace walk nor repeats the exception it throws when no schema exists.
  const type = lookupCachedType(typeName)
  if (!type) {
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
