/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Configuration validation.
 *
 * Both sign-in values are copied by hand from browser developer tools, so the
 * interesting cases are the copy mistakes. Each produces an unexplained Google
 * error at runtime if it is not caught here.
 */

import { ConfigurationError } from '../../../src/errors'
import { validateConfig } from '../../../src/utils/validators'
import type { MyNestPlatformConfig } from '../../../src/types/config'
import { TEST_COOKIES, TEST_ISSUE_TOKEN } from '../../helpers/sign-in'

const base = (overrides: Partial<MyNestPlatformConfig> = {}): MyNestPlatformConfig => ({
  platform: 'MyNest',
  issueToken: TEST_ISSUE_TOKEN,
  cookies: TEST_COOKIES,
  ...overrides,
})

describe('validateConfig', () => {
  it('accepts a minimal valid configuration', () => {
    const { config, warnings } = validateConfig(base())

    expect(config.issueToken).toBe(TEST_ISSUE_TOKEN)
    expect(config.cookies).toBe(TEST_COOKIES)
    expect(warnings).toEqual([])
  })

  it('applies the documented defaults', () => {
    const { config } = validateConfig(base())

    expect(config).toMatchObject({
      name: 'MyNest',
      fieldTest: false,
      // Opt-in: omitted key must stay false so upgrades do not start HVAC writes.
      allowThermostatControl: false,
      exposeGlobalEcoSwitch: false,
      exposeProtectOccupancy: true,
      exposeProtectTemperature: false,
      diagnosticsInterval: 0,
      structuredLogs: false,
      pagerdutySignals: false,
      debug: false,
    })
    expect(config.ignoredDeviceIds.size).toBe(0)
  })

  it('clamps a too-short diagnostics interval with a warning', () => {
    const { config, warnings } = validateConfig(base({ diagnosticsInterval: 10 }))
    expect(config.diagnosticsInterval).toBe(30)
    expect(warnings.join('\n')).toMatch(/Diagnostics Interval was raised from 10 to 30/)
  })

  it('accepts a three-hour diagnostics interval', () => {
    const { config, warnings } = validateConfig(base({ diagnosticsInterval: 10_800 }))
    expect(config.diagnosticsInterval).toBe(10_800)
    expect(warnings).toEqual([])
  })

  it('accepts a one-day diagnostics interval', () => {
    const { config } = validateConfig(base({ diagnosticsInterval: 86_400 }))
    expect(config.diagnosticsInterval).toBe(86_400)
  })

  it('rejects a diagnostics interval above 24 hours', () => {
    expect(() => validateConfig(base({ diagnosticsInterval: 86_401 }))).toThrow(/86400/)
  })

  it('rejects a negative diagnostics interval', () => {
    expect(() => validateConfig(base({ diagnosticsInterval: -1 }))).toThrow(/Diagnostics Interval/)
  })

  it('keeps the values the user set', () => {
    const { config } = validateConfig(base({
      name: 'Upstairs Nest',
      fieldTest: true,
      allowThermostatControl: true,
      exposeGlobalEcoSwitch: true,
      exposeProtectOccupancy: false,
      exposeProtectTemperature: true,
      debug: true,
    }))

    expect(config).toMatchObject({
      name: 'Upstairs Nest',
      fieldTest: true,
      allowThermostatControl: true,
      exposeGlobalEcoSwitch: true,
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
  ])('points to the setup guide when the Issue Token URL is %s', (_label, issueToken) => {
    expect(() => validateConfig(base({ issueToken }))).toThrow(ConfigurationError)
    expect(() => validateConfig(base({ issueToken }))).toThrow(/Issue Token URL is required.*docs\/AUTH\.md/)
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['a number', 42],
  ])('points to the setup guide when the Cookies are %s', (_label, cookies) => {
    expect(() => validateConfig(base({ cookies }))).toThrow(/Cookies are required.*docs\/AUTH\.md/)
  })

  it('rejects text that is not a URL', () => {
    expect(() => validateConfig(base({ issueToken: 'issueToken please' }))).toThrow(/not a valid URL/)
  })

  it.each([
    ['another host', 'https://accounts.example.com/o/oauth2/iframerpc?action=issueToken'],
    ['a lookalike host', 'https://accounts.google.com.example.com/o/oauth2/iframerpc?action=issueToken'],
    ['plain http', 'http://accounts.google.com/o/oauth2/iframerpc?action=issueToken'],
    ['a non-default port', 'https://accounts.google.com:8443/o/oauth2/iframerpc?action=issueToken'],
    ['embedded credentials', 'https://user:pass@accounts.google.com/o/oauth2/iframerpc?action=issueToken'],
    ['another path', 'https://accounts.google.com/o/oauth2/iframe?action=issueToken'],
  ])('refuses an Issue Token URL on %s, because the cookies are sent to it', (_label, issueToken) => {
    expect(() => validateConfig(base({ issueToken }))).toThrow(/must start with https:\/\/accounts\.google\.com/)
  })

  it('names the right request when the URL is from another iframerpc call', () => {
    const issueToken = 'https://accounts.google.com/o/oauth2/iframerpc?action=checkOrigin'

    expect(() => validateConfig(base({ issueToken }))).toThrow(/action=issueToken/)
  })

  it('trims whitespace picked up when copying the URL', () => {
    const { config } = validateConfig(base({ issueToken: `  ${TEST_ISSUE_TOKEN}\n` }))

    expect(config.issueToken).toBe(TEST_ISSUE_TOKEN)
  })

  it('accepts cookies pasted with the header name in front', () => {
    const { config } = validateConfig(base({ cookies: `Cookie: ${TEST_COOKIES}\n` }))

    expect(config.cookies).toBe(TEST_COOKIES)
  })

  it('refuses cookies without the Google session cookie', () => {
    expect(() => validateConfig(base({ cookies: 'NID=test-nid; OTZ=test-otz' }))).toThrow(/SID cookie/)
  })

  it('does not mistake a cookie that only ends in SID for the session cookie', () => {
    expect(() => validateConfig(base({ cookies: 'HSID=test-hsid; SSID=test-ssid' }))).toThrow(/SID cookie/)
  })

  it('warns when pointed at the field-test servers', () => {
    const { warnings } = validateConfig(base({ fieldTest: true }))

    expect(warnings.join(' ')).toContain('Field Test option')
    expect(warnings.join(' ')).toContain('field-test')
  })

  it('accepts an ignore list in either id form', () => {
    // The Nest app shows the bare serial; the Observe stream prefixes it.
    const { config } = validateConfig(base({
      ignoredDeviceIds: ['DEVICE_18B4300000000001', '18b4300000000002', '  '],
    }))

    expect([...config.ignoredDeviceIds].sort())
      .toEqual(['18B4300000000001', '18B4300000000002'])
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
