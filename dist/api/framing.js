"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Length-delimited framing for the Nest Observe stream.
 *
 * Nest streams protobuf messages as `[tag byte][varint length][payload]`. Two
 * details are easy to get wrong and both were confirmed against captured
 * traffic:
 *
 *  1. The frame handed to the protobuf decoder must include the tag byte and
 *     the varint, not just the payload. Stripping them yields a buffer that
 *     `StreamBody.decode` accepts and reports as empty, which looks like a
 *     quiet home rather than a parsing bug.
 *  2. HTTP/2 chunk boundaries have nothing to do with frame boundaries. A
 *     single chunk may carry several frames, part of one, or fewer than the
 *     two bytes needed to read the length. Anything that assumes otherwise
 *     works on a 300 KB snapshot and then corrupts the small delta frames that
 *     follow it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FrameSplitter = exports.FramingError = exports.MAX_FRAME_BYTES = void 0;
/**
 * Largest frame this plugin will assemble, as a guard against a corrupt or
 * hostile length prefix.
 *
 * The initial trait snapshot on a home with fifteen devices is around 300 KB,
 * so this leaves two orders of magnitude of headroom. Without a ceiling, one
 * bad varint would have the plugin buffer without bound waiting for bytes that
 * are never coming.
 */
exports.MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** A frame is at minimum a tag byte plus a one-byte varint length. */
const MIN_FRAME_HEADER_BYTES = 2;
/** Tag byte plus the longest a varint32 length prefix can be. */
const MAX_FRAME_HEADER_BYTES = 6;
/** Raised when the stream cannot be parsed and the connection must be dropped. */
class FramingError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FramingError';
    }
}
exports.FramingError = FramingError;
/**
 * Read a base-128 varint.
 *
 * @returns The decoded value, or `null` when the buffer ends mid-varint and
 *   more bytes are needed.
 */
function readVarint(buffer, offset) {
    let value = 0;
    let shift = 0;
    let index = offset;
    while (index < buffer.length) {
        const byte = buffer[index++];
        // Multiplication rather than `<<`: JavaScript's bitwise operators coerce to
        // 32-bit signed, so a five-byte varint shifted with `<<` goes negative.
        value += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) {
            return { value, byteLength: index - offset };
        }
        shift += 7;
        // A length prefix is a varint32: five bytes at most, the last of them read
        // at shift 28. Reaching shift 35 means a sixth byte is coming, which would
        // let a corrupt prefix decode past 2^35 before the frame-size ceiling
        // rejects it.
        if (shift >= 35) {
            throw new FramingError('Observe stream carried a malformed length prefix');
        }
    }
    return null;
}
/**
 * Reassembles Nest Observe frames from arbitrary chunk boundaries.
 *
 * One instance belongs to one connection; a reconnect starts a new splitter
 * because a partially received frame cannot span connections.
 */
class FrameSplitter {
    #buffer = Buffer.alloc(0);
    /**
     * Chunks received since the last concat.
     *
     * Concatenating on every chunk is quadratic in the frame size: a 16 MB frame
     * arriving in 16 KB pieces would copy ~8 GB, blocking the event loop and
     * starving every other plugin. Holding the pieces and joining once, when the
     * announced length is actually available, keeps it linear.
     */
    #pending = [];
    #pendingBytes = 0;
    /**
     * Add bytes from the wire and take every complete frame they finish.
     *
     * @returns Complete frames, each including its tag byte and length prefix.
     * @throws {FramingError} When the stream is unparseable, which is not
     *   recoverable by waiting for more bytes.
     */
    push(chunk) {
        if (chunk.length > 0) {
            this.#pending.push(chunk);
            this.#pendingBytes += chunk.length;
        }
        // Only materialise once there is plausibly a whole frame to read. The
        // header is a tag byte plus a varint of at most five bytes.
        if (this.#needsMoreBytes()) {
            return [];
        }
        this.#coalesce();
        const frames = [];
        for (;;) {
            // A frame is at minimum a tag byte plus a one-byte varint.
            if (this.#buffer.length < 2) {
                break;
            }
            const length = readVarint(this.#buffer, 1);
            if (length === null) {
                break;
            }
            const totalLength = 1 + length.byteLength + length.value;
            if (totalLength > exports.MAX_FRAME_BYTES) {
                throw new FramingError(`Observe stream announced a ${totalLength} byte frame, beyond the ${exports.MAX_FRAME_BYTES} byte limit`);
            }
            if (this.#buffer.length < totalLength) {
                break;
            }
            // `Buffer.from` copies. Handing out a view would leave every frame
            // pinning the whole concatenated buffer alive for as long as any
            // consumer held it. The residual is copied for the same reason: a
            // 12-byte leftover must not keep a ~300 KB snapshot allocation reachable.
            frames.push(Buffer.from(this.#buffer.subarray(0, totalLength)));
            this.#buffer = this.#buffer.length === totalLength
                ? Buffer.alloc(0)
                : Buffer.from(this.#buffer.subarray(totalLength));
        }
        return frames;
    }
    /**
     * Whether the bytes held so far cannot yet complete a frame.
     *
     * Reads the announced length from the head of the buffered data without
     * joining it, so a large frame is copied once rather than once per chunk.
     */
    #needsMoreBytes() {
        const total = this.#buffer.length + this.#pendingBytes;
        if (total < MIN_FRAME_HEADER_BYTES) {
            return true;
        }
        const header = this.#peekHeader();
        const length = readVarint(header, 1);
        if (length === null) {
            // Header itself is still incomplete; only wait if a longer varint could
            // still arrive, otherwise fall through so `push` raises the framing error.
            return header.length < MAX_FRAME_HEADER_BYTES;
        }
        const totalLength = 1 + length.byteLength + length.value;
        // An announced length beyond the ceiling must be rejected now, not waited
        // on — buffering toward it is exactly what the ceiling exists to prevent.
        if (totalLength > exports.MAX_FRAME_BYTES) {
            return false;
        }
        return total < totalLength;
    }
    /** The first few bytes of the buffered data, without joining all of it. */
    #peekHeader() {
        if (this.#buffer.length >= MAX_FRAME_HEADER_BYTES || this.#pending.length === 0) {
            return this.#buffer.subarray(0, MAX_FRAME_HEADER_BYTES);
        }
        const parts = [this.#buffer];
        let collected = this.#buffer.length;
        for (const chunk of this.#pending) {
            if (collected >= MAX_FRAME_HEADER_BYTES) {
                break;
            }
            parts.push(chunk);
            collected += chunk.length;
        }
        return Buffer.concat(parts).subarray(0, MAX_FRAME_HEADER_BYTES);
    }
    /** Join the buffered chunks into the working buffer. */
    #coalesce() {
        if (this.#pending.length === 0) {
            return;
        }
        this.#buffer = this.#buffer.length === 0 && this.#pending.length === 1
            ? this.#pending[0]
            : Buffer.concat([this.#buffer, ...this.#pending]);
        this.#pending = [];
        this.#pendingBytes = 0;
    }
    /** Bytes held for a frame that is not yet complete. */
    get pendingBytes() {
        return this.#buffer.length + this.#pendingBytes;
    }
}
exports.FrameSplitter = FrameSplitter;
//# sourceMappingURL=framing.js.map