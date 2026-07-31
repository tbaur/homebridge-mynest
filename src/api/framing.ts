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
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** Raised when the stream cannot be parsed and the connection must be dropped. */
export class FramingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FramingError'
  }
}

interface Varint {
  readonly value: number
  readonly byteLength: number
}

/**
 * Read a base-128 varint.
 *
 * @returns The decoded value, or `null` when the buffer ends mid-varint and
 *   more bytes are needed.
 */
function readVarint(buffer: Buffer, offset: number): Varint | null {
  let value = 0
  let shift = 0
  let index = offset

  while (index < buffer.length) {
    const byte = buffer[index++]!
    // Multiplication rather than `<<`: JavaScript's bitwise operators coerce to
    // 32-bit signed, so a five-byte varint shifted with `<<` goes negative.
    value += (byte & 0x7f) * 2 ** shift

    if ((byte & 0x80) === 0) {
      return { value, byteLength: index - offset }
    }

    shift += 7
    if (shift > 35) {
      throw new FramingError('Observe stream carried a malformed length prefix')
    }
  }

  return null
}

/**
 * Reassembles Nest Observe frames from arbitrary chunk boundaries.
 *
 * One instance belongs to one connection; a reconnect starts a new splitter
 * because a partially received frame cannot span connections.
 */
export class FrameSplitter {
  #buffer: Buffer = Buffer.alloc(0)

  /**
   * Add bytes from the wire and take every complete frame they finish.
   *
   * @returns Complete frames, each including its tag byte and length prefix.
   * @throws {FramingError} When the stream is unparseable, which is not
   *   recoverable by waiting for more bytes.
   */
  push(chunk: Buffer): Buffer[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])

    const frames: Buffer[] = []

    for (;;) {
      // A frame is at minimum a tag byte plus a one-byte varint.
      if (this.#buffer.length < 2) {
        break
      }

      const length = readVarint(this.#buffer, 1)
      if (length === null) {
        break
      }

      const totalLength = 1 + length.byteLength + length.value
      if (totalLength > MAX_FRAME_BYTES) {
        throw new FramingError(
          `Observe stream announced a ${totalLength} byte frame, beyond the ${MAX_FRAME_BYTES} byte limit`,
        )
      }

      if (this.#buffer.length < totalLength) {
        break
      }

      // `Buffer.from` copies. Handing out a view would leave every frame
      // pinning the whole concatenated buffer alive for as long as any
      // consumer held it. The residual is copied for the same reason: a
      // 12-byte leftover must not keep a ~300 KB snapshot allocation reachable.
      frames.push(Buffer.from(this.#buffer.subarray(0, totalLength)))
      this.#buffer = this.#buffer.length === totalLength
        ? Buffer.alloc(0)
        : Buffer.from(this.#buffer.subarray(totalLength))
    }

    return frames
  }

  /** Bytes held for a frame that is not yet complete. */
  get pendingBytes(): number {
    return this.#buffer.length
  }
}
