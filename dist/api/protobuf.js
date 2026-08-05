"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSchemas = loadSchemas;
exports.readObserveTraitsRequest = readObserveTraitsRequest;
exports.decodeFrame = decodeFrame;
exports.decodeTrait = decodeTrait;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const protobufjs_1 = __importDefault(require("protobufjs"));
/**
 * Locate the vendored protobuf schemas.
 *
 * The path is the same two levels up from both `src/api` under ts-jest and
 * `dist/api` in the published package, so one candidate covers both. The
 * others exist so a misconfigured `files` list in package.json fails with a
 * clear message rather than an obscure protobufjs parse error.
 */
let cachedSchemaDirectory = null;
function resolveSchemaDirectory() {
    if (cachedSchemaDirectory !== null) {
        return cachedSchemaDirectory;
    }
    // One candidate only. The path is the same two levels up from both `src/api`
    // under ts-jest and `dist/api` in the published package. A `../../..` fallback
    // resolves to `node_modules/assets/protobuf` for an installed package — outside
    // this package entirely — so a broken install would silently load wire-format
    // schemas that any other package's postinstall could have planted, and those
    // schemas decide how remote bytes become device state.
    const candidate = (0, node_path_1.resolve)(__dirname, '..', '..', 'assets', 'protobuf');
    if ((0, node_fs_1.existsSync)((0, node_path_1.join)(candidate, 'root.proto'))) {
        cachedSchemaDirectory = candidate;
        return candidate;
    }
    throw new Error(`Could not find the bundled Nest protobuf schemas. Looked in: ${candidate}`);
}
let cachedRoot = null;
let cachedTraitsRequest = null;
/**
 * Load the protobuf schemas once per process.
 *
 * Loading is synchronous and happens on first use rather than at import time,
 * so a schema problem surfaces as a startup error the user can read instead of
 * a module-loading crash.
 */
function loadSchemas() {
    cachedRoot ??= protobufjs_1.default.loadSync((0, node_path_1.join)(resolveSchemaDirectory(), 'root.proto'));
    return cachedRoot;
}
/**
 * The opaque request body that tells Nest which traits to stream.
 *
 * Read once. This is called on every Observe connection, and reconnects can
 * come every few seconds during an outage — synchronous filesystem IO on the
 * event loop at that cadence stalls every plugin in the process.
 */
function readObserveTraitsRequest() {
    cachedTraitsRequest ??= (0, node_fs_1.readFileSync)((0, node_path_1.join)(resolveSchemaDirectory(), 'ObserveTraits.protobuf'));
    return cachedTraitsRequest;
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
function decodeFrame(frame) {
    const streamBody = lookupCachedType('nest.rpc.StreamBody');
    if (!streamBody) {
        return { traits: [], isUndecodable: true };
    }
    let decoded;
    try {
        decoded = streamBody.decode(frame);
    }
    catch {
        return { traits: [], isUndecodable: true };
    }
    const traits = [];
    for (const message of decoded.message ?? []) {
        for (const get of message.get ?? []) {
            const resourceId = get.object?.id;
            const key = get.object?.key;
            if (typeof resourceId !== 'string' || typeof key !== 'string') {
                continue;
            }
            const property = get.data?.property;
            const typeUrl = typeof property?.type_url === 'string'
                ? property.type_url
                : typeof property?.typeUrl === 'string'
                    ? property.typeUrl
                    : undefined;
            const value = property?.value;
            traits.push({
                resourceId,
                key,
                typeUrl,
                value: value instanceof Uint8Array ? Buffer.from(value) : undefined,
            });
        }
    }
    const status = decoded.status;
    if (status && (status.code !== undefined || status.message !== undefined)) {
        return {
            traits,
            status: {
                code: typeof status.code === 'number' ? status.code : undefined,
                message: typeof status.message === 'string' ? status.message : undefined,
            },
        };
    }
    return { traits };
}
/**
 * Trait type names already known to have no vendored schema.
 *
 * Bounded: the names come from Nest, so an unbounded set is a slow leak driven
 * by remote input. Past the cap the lookup simply repeats, which costs a little
 * time rather than memory that is never reclaimed.
 */
const MAX_UNKNOWN_TYPES = 512;
const unknownTypes = new Set();
/**
 * Resolved protobuf types, memoized.
 *
 * `lookupType` splits the name and walks the namespace on every call, and the
 * opening snapshot alone is hundreds of traits — the negative results were
 * already cached, but the successful ones were re-resolved per frame.
 */
const resolvedTypes = new Map();
/** Resolve a protobuf type once, or `undefined` when no schema covers it. */
function lookupCachedType(typeName) {
    const cached = resolvedTypes.get(typeName);
    if (cached) {
        return cached;
    }
    if (unknownTypes.has(typeName)) {
        return undefined;
    }
    try {
        const type = loadSchemas().lookupType(typeName);
        if (resolvedTypes.size < MAX_UNKNOWN_TYPES) {
            resolvedTypes.set(typeName, type);
        }
        return type;
    }
    catch {
        if (unknownTypes.size < MAX_UNKNOWN_TYPES) {
            unknownTypes.add(typeName);
        }
        return undefined;
    }
}
/**
 * Decode a trait payload into a plain object.
 *
 * @returns `undefined` when there is no vendored schema for the type or the
 *   payload does not match it. Both are expected: Nest streams every trait a
 *   device has, and this plugin reads a small subset of them.
 */
function decodeTrait(update) {
    if (!update.typeUrl || !update.value || update.value.length === 0) {
        return undefined;
    }
    const typeName = update.typeUrl.split('/').pop();
    if (!typeName) {
        return undefined;
    }
    // Memoized both ways: a trait streamed on every frame neither repeats the
    // namespace walk nor repeats the exception it throws when no schema exists.
    const type = lookupCachedType(typeName);
    if (!type) {
        return undefined;
    }
    try {
        return type.toObject(type.decode(update.value), {
            enums: String,
            longs: String,
            defaults: false,
        });
    }
    catch {
        return undefined;
    }
}
