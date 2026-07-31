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
import protobuf from 'protobufjs';
/** One trait reading lifted out of an Observe frame. */
export interface TraitUpdate {
    /** Resource id, e.g. `DEVICE_18B4300000ACC1AD` or `STRUCTURE_…`. */
    readonly resourceId: string;
    /** Trait name in snake_case, e.g. `target_temperature_settings`. */
    readonly key: string;
    /** Fully qualified protobuf type, e.g. `type.nestlabs.com/nest.trait.…`. */
    readonly typeUrl?: string;
    /** Undecoded trait payload. */
    readonly value?: Buffer;
}
/** Outcome of decoding one frame off the wire. */
export interface DecodedFrame {
    readonly traits: readonly TraitUpdate[];
    /** Set when Nest reported a stream-level status instead of trait data. */
    readonly status?: {
        code?: number;
        message?: string;
    };
}
/**
 * Load the protobuf schemas once per process.
 *
 * Loading is synchronous and happens on first use rather than at import time,
 * so a schema problem surfaces as a startup error the user can read instead of
 * a module-loading crash.
 */
export declare function loadSchemas(): protobuf.Root;
/** The opaque request body that tells Nest which traits to stream. */
export declare function readObserveTraitsRequest(): Buffer;
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
export declare function decodeFrame(frame: Buffer): DecodedFrame;
/**
 * Decode a trait payload into a plain object.
 *
 * @returns `undefined` when there is no vendored schema for the type or the
 *   payload does not match it. Both are expected: Nest streams every trait a
 *   device has, and this plugin reads a small subset of them.
 */
export declare function decodeTrait(update: TraitUpdate): Record<string, unknown> | undefined;
//# sourceMappingURL=protobuf.d.ts.map