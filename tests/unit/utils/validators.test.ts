/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Configuration validation.
 *
 * `access_token` sits in a JSON blob beside half a dozen other tokens, so the
 * interesting cases are the wrong ones users reach for. Each produces an
 * unexplained HTTP 401 at runtime if it is not caught here.
 */

import { ConfigurationError } from '../../../src/errors'
import { validateConfig } from '../../../src/utils/validators'
import type { MyNestPlatformConfig } from '../../../src/types/config'

const VALID_TOKEN = 'b'.repeat(120)

const base = (overrides: Partial<MyNestPlatformConfig> = {}): MyNestPlatformConfig => ({
  platform: 'MyNest',
  accessToken: VALID_TOKEN,
  ...overrides,
})

describe('validateConfig', () => {
  it('accepts a minimal valid configuration', () => {
    const { config, warnings } = validateConfig(base())

    expect(config.accessToken).toBe(VALID_TOKEN)
    expect(warnings).toEqual([])
  })

  it('applies the documented defaults', () => {
    const { config } = validateConfig(base())

    expect(config).toMatchObject({
      name: 'MyNest',
      fieldTest: false,
      // Writing to a thermostat is a different class of risk from reading one,
      // so it stays off until asked for.
      allowThermostatControl: false,
      exposeProtectOccupancy: true,
      exposeProtectTemperature: false,
      diagnosticsInterval: 0,
      structuredLogs: false,
      debug: false,
    })
    expect(config.ignoredDeviceIds.size).toBe(0)
  })

  it('clamps a too-short diagnostics interval with a warning', () => {
    const { config, warnings } = validateConfig(base({ diagnosticsInterval: 10 }))
    expect(config.diagnosticsInterval).toBe(30)
    expect(warnings.join('\n')).toMatch(/Diagnostics Interval was raised from 10 to 30/)
  })

  it('rejects a negative diagnostics interval', () => {
    expect(() => validateConfig(base({ diagnosticsInterval: -1 }))).toThrow(/Diagnostics Interval/)
  })

  it('keeps the values the user set', () => {
    const { config } = validateConfig(base({
      name: 'Upstairs Nest',
      fieldTest: true,
      allowThermostatControl: true,
      exposeProtectOccupancy: false,
      exposeProtectTemperature: true,
      debug: true,
    }))

    expect(config).toMatchObject({
      name: 'Upstairs Nest',
      fieldTest: true,
      allowThermostatControl: true,
      exposeProtectOccupancy: false,
      exposeProtectTemperature: true,
      debug: true,
    })
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['a number', 42],
    ['null', null],
  ])('tells the user where to find the token when it is %s', (_label, accessToken) => {
    expect(() => validateConfig(base({ accessToken }))).toThrow(ConfigurationError)
    expect(() => validateConfig(base({ accessToken }))).toThrow(/home\.nest\.com\/session/)
  })

  it('recognises a Google account JWT and says why it cannot work', () => {
    // Users following a guide written for the Google auth path arrive with one
    // of these; "401" would tell them nothing.
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${'a'.repeat(60)}.${'b'.repeat(40)}`

    expect(() => validateConfig(base({ accessToken: jwt })))
      .toThrow(/Nest Account token/)
  })

  it('recognises a Google OAuth token', () => {
    expect(() => validateConfig(base({ accessToken: `ya29.${'a'.repeat(80)}` })))
      .toThrow(/Google OAuth token/)
  })

  it('rejects a token short enough to have been truncated', () => {
    // Matches config.schema.json minLength so the UI and runtime agree.
    expect(() => validateConfig(base({ accessToken: 'short-token' })))
      .toThrow(/truncated|shorter than/i)
  })

  it('trims whitespace picked up when copying', () => {
    const { config } = validateConfig(base({ accessToken: `  ${VALID_TOKEN}\n` }))

    expect(config.accessToken).toBe(VALID_TOKEN)
  })

  it('warns when pointed at the field-test servers', () => {
    const { warnings } = validateConfig(base({ fieldTest: true }))

    expect(warnings.join(' ')).toContain('Field Test option')
    expect(warnings.join(' ')).toContain('field-test')
  })

  it('accepts an ignore list in either id form', () => {
    // The Nest app shows the bare serial; the Observe stream prefixes it.
    const { config } = validateConfig(base({
      ignoredDeviceIds: ['DEVICE_18B4300000ACC1AD', '18b4300000acbfbd', '  '],
    }))

    expect([...config.ignoredDeviceIds].sort())
      .toEqual(['18B4300000ACBFBD', '18B4300000ACC1AD'])
  })

  it('warns and carries on when the ignore list is not a list', () => {
    const { config, warnings } = validateConfig(base({ ignoredDeviceIds: 'DEVICE_ABC' }))

    expect(config.ignoredDeviceIds.size).toBe(0)
    expect(warnings.join(' ')).toContain('Ignored Device IDs')
  })

  it('skips non-string entries in the ignore list', () => {
    const { config } = validateConfig(base({ ignoredDeviceIds: ['ABC123', 42, null] }))

    expect([...config.ignoredDeviceIds]).toEqual(['ABC123'])
  })

  it('falls back silently when a non-boolean is given for a boolean option', () => {
    const { config, warnings } = validateConfig(base({ debug: 'yes', fieldTest: 1 }))

    expect(config.debug).toBe(false)
    expect(config.fieldTest).toBe(false)
    expect(warnings.join(' ')).not.toMatch(/boolean|on or off/i)
  })

  it('falls back to the platform name when the name is blank', () => {
    expect(validateConfig(base({ name: '   ' })).config.name).toBe('MyNest')
  })
})
