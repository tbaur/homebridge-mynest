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
/**
 * Largest frame this plugin will assemble, as a guard against a corrupt or
 * hostile length prefix.
 *
 * The initial trait snapshot on a home with fifteen devices is around 300 KB,
 * so this leaves two orders of magnitude of headroom. Without a ceiling, one
 * bad varint would have the plugin buffer without bound waiting for bytes that
 * are never coming.
 */
export declare const MAX_FRAME_BYTES: number;
/** Raised when the stream cannot be parsed and the connection must be dropped. */
export declare class FramingError extends Error {
    constructor(message: string);
}
/**
 * Reassembles Nest Observe frames from arbitrary chunk boundaries.
 *
 * One instance belongs to one connection; a reconnect starts a new splitter
 * because a partially received frame cannot span connections.
 */
export declare class FrameSplitter {
    #private;
    /**
     * Add bytes from the wire and take every complete frame they finish.
     *
     * @returns Complete frames, each including its tag byte and length prefix.
     * @throws {FramingError} When the stream is unparseable, which is not
     *   recoverable by waiting for more bytes.
     */
    push(chunk: Buffer): Buffer[];
    /** Bytes held for a frame that is not yet complete. */
    get pendingBytes(): number;
}
//# sourceMappingURL=framing.d.ts.map