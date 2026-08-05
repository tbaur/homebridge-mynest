/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Reassembling Observe frames from arbitrary HTTP/2 chunks.
 *
 * The stream gives no guarantee about where a chunk ends, so the splitter has
 * to survive a frame arriving one byte at a time and several frames arriving at
 * once. These tests drive the same data at every chunk size to prove that.
 */

import { FrameSplitter, FramingError, MAX_FRAME_BYTES } from '../../../src/api/framing'
import { buildFrame, frameLengthDelimited, heatingThermostatTraits } from '../../helpers/observe-fixtures'

describe('FrameSplitter', () => {
  it('returns a whole frame delivered in one chunk', () => {
    const frame = buildFrame(heatingThermostatTraits())
    const splitter = new FrameSplitter()

    const frames = splitter.push(frame)

    expect(frames).toHaveLength(1)
    expect(frames[0].equals(frame)).toBe(true)
    expect(splitter.pendingBytes).toBe(0)
  })

  it('reassembles a frame split across every possible boundary', () => {
    const frame = buildFrame(heatingThermostatTraits())

    for (const chunkSize of [1, 2, 3, 7, 64, 512, frame.length - 1]) {
      const splitter = new FrameSplitter()
      const collected: Buffer[] = []

      for (let offset = 0; offset < frame.length; offset += chunkSize) {
        collected.push(...splitter.push(frame.subarray(offset, offset + chunkSize)))
      }

      expect(collected).toHaveLength(1)
      expect(collected[0].equals(frame)).toBe(true)
    }
  })

  it('returns several frames arriving in a single chunk, in order', () => {
    const first = buildFrame(heatingThermostatTraits('DEVICE_ONE'))
    const second = buildFrame(heatingThermostatTraits('DEVICE_TWO'))
    const splitter = new FrameSplitter()

    const frames = splitter.push(Buffer.concat([first, second]))

    expect(frames).toHaveLength(2)
    expect(frames[0].equals(first)).toBe(true)
    expect(frames[1].equals(second)).toBe(true)
  })

  it('holds a partial frame rather than emitting it', () => {
    const frame = buildFrame(heatingThermostatTraits())
    const splitter = new FrameSplitter()

    expect(splitter.push(frame.subarray(0, frame.length - 5))).toHaveLength(0)
    expect(splitter.pendingBytes).toBeGreaterThan(0)
    expect(splitter.push(frame.subarray(frame.length - 5))).toHaveLength(1)
  })

  it('ignores an empty chunk', () => {
    const splitter = new FrameSplitter()
    expect(splitter.push(Buffer.alloc(0))).toHaveLength(0)
  })

  it('preserves the tag byte and length prefix the decoder needs', () => {
    // `decodeFrame` hands the whole framed buffer to `StreamBody.decode`, so a
    // splitter that stripped the header would break decoding entirely.
    const frame = buildFrame(heatingThermostatTraits())
    const [emitted] = new FrameSplitter().push(frame)

    expect(emitted[0]).toBe(0x00)
    expect(emitted.length).toBe(frame.length)
  })

  it('refuses a frame larger than the ceiling instead of buffering it', () => {
    const splitter = new FrameSplitter()
    // A declared length beyond the ceiling, with no payload behind it: a
    // corrupt stream must not be able to make the plugin allocate without limit.
    const header = frameLengthDelimited(Buffer.alloc(0))
    const oversized = Buffer.concat([
      header.subarray(0, 1),
      encodeVarint(MAX_FRAME_BYTES + 1),
    ])

    expect(() => splitter.push(oversized)).toThrow(FramingError)
  })

  it('rejects a length prefix longer than a varint32', () => {
    // Five bytes is the most a varint32 can occupy. A sixth would decode past
    // 2^35 before the frame-size ceiling could reject it.
    const splitter = new FrameSplitter()
    const sixByteVarint = Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])

    expect(() => splitter.push(sixByteVarint)).toThrow(FramingError)
  })

  // The splitter buffers chunks and joins them only once a whole frame is
  // available, rather than concatenating on every chunk. That is what keeps a
  // large frame linear instead of quadratic, and it is also where a reassembly
  // bug hides: the module's own header warns that a broken splitter "works on a
  // 300 KB snapshot and then corrupts the small delta frames that follow it".
  describe('the opening snapshot followed by delta frames', () => {
    /** A frame whose payload is large enough to need a multi-byte varint. */
    function bigFrame(size: number, fill: number): Buffer {
      return frameLengthDelimited(Buffer.alloc(size, fill))
    }

    it('separates a large frame from the small frames behind it', () => {
      const snapshot = bigFrame(300 * 1024, 0xab)
      const deltas = [1, 2, 3].map((n) => frameLengthDelimited(Buffer.alloc(8, n)))
      const stream = Buffer.concat([snapshot, ...deltas])

      // 16 KB is a realistic socket read size, so the snapshot spans ~19 chunks
      // and the final chunk carries the snapshot tail plus every delta.
      const splitter = new FrameSplitter()
      const collected: Buffer[] = []
      for (let offset = 0; offset < stream.length; offset += 16 * 1024) {
        collected.push(...splitter.push(stream.subarray(offset, offset + 16 * 1024)))
      }

      expect(collected).toHaveLength(4)
      expect(collected[0].equals(snapshot)).toBe(true)
      expect(collected[1].equals(deltas[0]!)).toBe(true)
      expect(collected[2].equals(deltas[1]!)).toBe(true)
      expect(collected[3].equals(deltas[2]!)).toBe(true)
      expect(splitter.pendingBytes).toBe(0)
    })

    it('keeps the residual intact when a chunk ends mid-frame', () => {
      const first = bigFrame(70 * 1024, 0x11)
      const second = frameLengthDelimited(Buffer.alloc(12, 0x22))
      const stream = Buffer.concat([first, second])

      // Cut two bytes into the second frame, so a partial header is left over.
      const splitPoint = first.length + 2
      const splitter = new FrameSplitter()

      const firstBatch = splitter.push(stream.subarray(0, splitPoint))
      expect(firstBatch).toHaveLength(1)
      expect(firstBatch[0].equals(first)).toBe(true)
      expect(splitter.pendingBytes).toBe(2)

      const secondBatch = splitter.push(stream.subarray(splitPoint))
      expect(secondBatch).toHaveLength(1)
      expect(secondBatch[0].equals(second)).toBe(true)
      expect(splitter.pendingBytes).toBe(0)
    })

    it('reports pending bytes while a large frame is still arriving', () => {
      const frame = bigFrame(40 * 1024, 0x33)
      const splitter = new FrameSplitter()

      let pushed = 0
      for (let offset = 0; offset < frame.length - 100; offset += 4096) {
        const chunk = frame.subarray(offset, Math.min(offset + 4096, frame.length - 100))
        expect(splitter.push(chunk)).toHaveLength(0)
        pushed += chunk.length
        expect(splitter.pendingBytes).toBe(pushed)
      }

      expect(splitter.push(frame.subarray(pushed))).toHaveLength(1)
    })

    it('does not lose buffered bytes when an empty chunk arrives mid-frame', () => {
      const frame = bigFrame(20 * 1024, 0x44)
      const splitter = new FrameSplitter()

      splitter.push(frame.subarray(0, 5_000))
      expect(splitter.push(Buffer.alloc(0))).toHaveLength(0)
      expect(splitter.pendingBytes).toBe(5_000)

      expect(splitter.push(frame.subarray(5_000))).toHaveLength(1)
    })

    it('emits a frame carrying no payload at all', () => {
      // Two bytes total: the tag plus a zero-length varint. The smallest thing
      // the splitter can be asked to recognise.
      const splitter = new FrameSplitter()
      const empty = frameLengthDelimited(Buffer.alloc(0))

      const frames = splitter.push(empty)

      expect(frames).toHaveLength(1)
      expect(frames[0].equals(empty)).toBe(true)
    })

    it('accepts a frame exactly at the ceiling', () => {
      // The ceiling counts the header, so the largest legal payload is
      // MAX_FRAME_BYTES minus the tag byte and the varint that describes it.
      const payloadSize = MAX_FRAME_BYTES - 1 - 4
      const frame = frameLengthDelimited(Buffer.alloc(payloadSize, 0x55))
      expect(frame.length).toBe(MAX_FRAME_BYTES)

      const frames = new FrameSplitter().push(frame)

      expect(frames).toHaveLength(1)
      expect(frames[0].length).toBe(MAX_FRAME_BYTES)
    })

    it('holds a plausible partial frame without emitting or throwing', () => {
      // A declared length inside the ceiling with almost none of the payload
      // present: the splitter must wait, not guess and not fail.
      const splitter = new FrameSplitter()
      const header = frameLengthDelimited(Buffer.alloc(100_000, 0x66)).subarray(0, 10)

      expect(splitter.push(header)).toHaveLength(0)
      expect(splitter.pendingBytes).toBe(10)
    })
  })
})

function encodeVarint(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value

  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining = Math.floor(remaining / 128)
  }
  bytes.push(remaining)

  return Buffer.from(bytes)
}
