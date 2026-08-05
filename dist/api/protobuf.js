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
    const candidates = [
        (0, node_path_1.resolve)(__dirname, '..', '..', 'assets', 'protobuf'),
        (0, node_path_1.resolve)(__dirname, '..', '..', '..', 'assets', 'protobuf'),
    ];
    for (const candidate of candidates) {
        if ((0, node_fs_1.existsSync)((0, node_path_1.join)(candidate, 'root.proto'))) {
            cachedSchemaDirectory = candidate;
            return candidate;
        }
    }
    throw new Error(`Could not find the bundled Nest protobuf schemas. Looked in: ${candidates.join(', ')}`);
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
    const root = loadSchemas();
    const streamBody = root.lookupType('nest.rpc.StreamBody');
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
    if (!typeName || unknownTypes.has(typeName)) {
        return undefined;
    }
    const root = loadSchemas();
    let type;
    try {
        type = root.lookupType(typeName);
    }
    catch {
        // Cached so a trait streamed on every frame does not repeat the lookup and
        // the exception it throws for the lifetime of the process.
        if (unknownTypes.size < MAX_UNKNOWN_TYPES) {
            unknownTypes.add(typeName);
        }
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
//# sourceMappingURL=protobuf.js.map