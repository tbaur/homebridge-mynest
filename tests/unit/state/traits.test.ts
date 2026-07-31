/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Safe readers for decoded Nest traits.
 *
 * Nest wraps nearly every scalar in a message, and proto3 omits anything at its
 * default, so "zero" and "never sent" look identical on the wire. Every reader
 * here answers `undefined` when it cannot be sure, because callers treat that
 * as "leave HomeKit alone" and a wrong `0` shows a thermostat reading freezing.
 */

import {
  readEnum,
  readHumidity,
  readIndirectFloat,
  readIntFlag,
  readNumber,
  readString,
  readTemperatureC,
} from '../../../src/state/traits'

describe('readNumber', () => {
  it('reads a number at a nested path', () => {
    expect(readNumber({ a: { b: { c: 4.5 } } }, 'a', 'b', 'c')).toBe(4.5)
  })

  it('returns nothing when the path is broken', () => {
    expect(readNumber({ a: {} }, 'a', 'b')).toBeUndefined()
    expect(readNumber(undefined, 'a')).toBeUndefined()
    expect(readNumber(null, 'a')).toBeUndefined()
    expect(readNumber('text', 'a')).toBeUndefined()
  })

  it('rejects a value that is not a finite number', () => {
    expect(readNumber({ a: '5' }, 'a')).toBeUndefined()
    expect(readNumber({ a: NaN }, 'a')).toBeUndefined()
    expect(readNumber({ a: Infinity }, 'a')).toBeUndefined()
  })

  it('accepts a genuine zero', () => {
    expect(readNumber({ a: 0 }, 'a')).toBe(0)
  })
})

describe('readString', () => {
  it('reads a non-empty string', () => {
    expect(readString({ label: 'Hallway' }, 'label')).toBe('Hallway')
  })

  it('treats an empty string as nothing', () => {
    // proto3 omits an empty string, so one that survives decoding says nothing.
    expect(readString({ label: '' }, 'label')).toBeUndefined()
  })

  it('rejects a non-string', () => {
    expect(readString({ label: 5 }, 'label')).toBeUndefined()
  })
})

describe('readIntFlag', () => {
  it('reads Nest\'s int-encoded booleans', () => {
    expect(readIntFlag({ canHeat: 1 }, 'canHeat')).toBe(true)
    expect(readIntFlag({ canHeat: 0 }, 'canHeat')).toBe(false)
  })

  it('reads a real boolean too', () => {
    expect(readIntFlag({ present: true }, 'present')).toBe(true)
    expect(readIntFlag({ present: false }, 'present')).toBe(false)
  })

  it('returns nothing for an absent flag', () => {
    // Absent means "Nest did not say" at this level; callers that know the
    // containing message arrived read it as false themselves.
    expect(readIntFlag({}, 'canHeat')).toBeUndefined()
  })
})

describe('readIndirectFloat', () => {
  it('unwraps Nest\'s Float_Indirect wrapper', () => {
    expect(readIndirectFloat({ setpoint: { value: 21.5 } }, 'setpoint')).toBe(21.5)
  })

  it('returns nothing when the wrapper arrived empty', () => {
    // The wrapper is present with no inner value when the reading is exactly
    // zero *or* was never sent, and the two cannot be told apart. A spurious
    // `undefined` costs one stale reading; a spurious `0` shows freezing.
    expect(readIndirectFloat({ setpoint: {} }, 'setpoint')).toBeUndefined()
  })
})

describe('readTemperatureC', () => {
  it('unwraps the doubly-nested temperature trait', () => {
    expect(readTemperatureC({ temperature: { value: { value: 21.8 } } })).toBe(21.8)
  })

  it('returns nothing for an empty trait', () => {
    expect(readTemperatureC({ temperature: { value: {} } })).toBeUndefined()
    expect(readTemperatureC({})).toBeUndefined()
    expect(readTemperatureC(undefined)).toBeUndefined()
  })

  it('rejects a reading no habitable building could produce', () => {
    // Guards against a decode landing on the wrong field, and against HomeKit
    // refusing a value outside its range, which throws rather than clamping.
    expect(readTemperatureC({ temperature: { value: { value: -273 } } })).toBeUndefined()
    expect(readTemperatureC({ temperature: { value: { value: 5000 } } })).toBeUndefined()
  })

  it('accepts a plausible sub-zero reading', () => {
    expect(readTemperatureC({ temperature: { value: { value: -10 } } })).toBe(-10)
  })
})

describe('readHumidity', () => {
  it('unwraps a humidity trait', () => {
    expect(readHumidity({ humidity: { value: { value: 45 } } })).toBe(45)
  })

  it('rejects a value outside a percentage', () => {
    expect(readHumidity({ humidity: { value: { value: 150 } } })).toBeUndefined()
    expect(readHumidity({ humidity: { value: { value: -1 } } })).toBeUndefined()
  })
})

describe('readEnum', () => {
  it('reads the symbolic name protobufjs renders', () => {
    expect(readEnum({ units: 'DEGREES_F' }, 'units')).toBe('DEGREES_F')
  })

  it('returns nothing when the enum was left at its default', () => {
    expect(readEnum({}, 'units')).toBeUndefined()
  })
})
