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
