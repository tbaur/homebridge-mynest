/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Keeping credentials out of logs.
 *
 * A Nest access token reads every sensor and changes every thermostat in the
 * home, with no password and no second factor, and Homebridge debug logs get
 * pasted into public issue trackers routinely. These tests cover each shape the
 * token is known to travel in.
 */

import {
  previewSecret,
  sanitizeError,
  sanitizeLogParameter,
  sanitizeString,
  sanitizeUrl,
} from '../../../src/utils/sanitizers'

const TOKEN = 'b0.b1.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOp'

describe('sanitizeString', () => {
  it('redacts a token in a JSON body', () => {
    // The JSON form needs its own rule: a quote sits between the key and its
    // colon, so no `name=value` pattern can match it.
    const result = sanitizeString(`{"access_token":"${TOKEN}","userid":"123"}`)

    expect(result).not.toContain(TOKEN)
    expect(result).toContain('"access_token":"***"')
  })

  it('redacts every spelling of the token key', () => {
    for (const key of ['access_token', 'accessToken', 'cztoken', 'refresh_token', 'refreshToken']) {
      expect(sanitizeString(`{"${key}":"${TOKEN}"}`)).not.toContain(TOKEN)
      expect(sanitizeString(`${key}=${TOKEN}`)).not.toContain(TOKEN)
    }
  })

  it('redacts the Weave pairing material returned beside the session', () => {
    for (const key of ['weave_token', 'service_config', 'pairing_token']) {
      expect(sanitizeString(`{"${key}":"${TOKEN}"}`)).not.toContain(TOKEN)
    }
  })

  it('redacts an Authorization header, which carries the token verbatim', () => {
    expect(sanitizeString(`Authorization: Basic ${TOKEN}`)).toBe('Authorization: Basic ***')
    expect(sanitizeString(`authorization: Bearer ${TOKEN}`)).toBe('authorization: Bearer ***')
  })

  it('redacts cookie headers in both header and JSON form', () => {
    expect(sanitizeString(`Cookie: cztoken=${TOKEN}; other=1`)).not.toContain(TOKEN)
    expect(sanitizeString(`{"cookie":"cztoken=${TOKEN}"}`)).not.toContain(TOKEN)
    expect(sanitizeString(`Set-Cookie: cztoken=${TOKEN}; Path=/`)).not.toContain(TOKEN)
  })

  it('redacts a bare cookie string with no header prefix', () => {
    // This is the shape the session request actually sends.
    const cookies = `G_ENABLED_IDPS=google; eu_cookie_accepted=1; cztoken=${TOKEN}`

    const result = sanitizeString(cookies)

    expect(result).not.toContain(TOKEN)
    // Preference cookies are not secrets and stay readable.
    expect(result).toContain('G_ENABLED_IDPS=google')
  })

  it('redacts an unknown long value rather than trusting an allowlist', () => {
    // A credential Nest starts issuing under a new name should cost a noisier
    // log, not a disclosure.
    const result = sanitizeString(`some_new_credential=${TOKEN}`)

    expect(result).not.toContain(TOKEN)
  })

  it('leaves short diagnostic values alone', () => {
    // Redacting every `name=value` would take `frame=2` with it and make the
    // log useless for debugging.
    expect(sanitizeString('frame=2 attempt=3 status=200'))
      .toBe('frame=2 attempt=3 status=200')
  })

  it('redacts the account id embedded in the app_launch path', () => {
    expect(sanitizeString('POST https://home.nest.com/api/0.1/user/5551234/app_launch'))
      .toContain('/user/***')
  })

  it('leaves text with nothing sensitive untouched', () => {
    expect(sanitizeString('Observe stream ended after 12 frames'))
      .toBe('Observe stream ended after 12 frames')
  })

  it('handles a large input without pathological backtracking', () => {
    const start = Date.now()
    sanitizeString('a='.repeat(20_000))

    expect(Date.now() - start).toBeLessThan(1000)
  })
})

describe('sanitizeError', () => {
  it('redacts a token carried in a thrown error', () => {
    // Redaction keys off the markers a token actually travels behind — a JSON
    // key, an auth scheme, a cookie pair. It deliberately does not redact every
    // long string, which would take device serials and protobuf type names with
    // it and leave the log useless.
    expect(sanitizeError(new Error(`request failed: Basic ${TOKEN}`))).not.toContain(TOKEN)
    expect(sanitizeError(new Error(`body was {"access_token":"${TOKEN}"}`))).not.toContain(TOKEN)
  })

  it('handles a thrown string or other value', () => {
    expect(sanitizeError(`cztoken=${TOKEN}`)).not.toContain(TOKEN)
    expect(sanitizeError(undefined)).toBe('undefined')
    expect(sanitizeError({ code: 500 })).toBe('[object Object]')
  })
})

describe('sanitizeLogParameter', () => {
  it('redacts inside an object rather than passing it through', () => {
    // Handing an object to the logger intact means its values never meet a
    // redaction pattern, and an access_token field prints in full.
    const result = sanitizeLogParameter({ access_token: TOKEN, userid: '123' })

    expect(String(result)).not.toContain(TOKEN)
    expect(String(result)).toContain('123')
  })

  it('passes primitives through unchanged', () => {
    expect(sanitizeLogParameter(42)).toBe(42)
    expect(sanitizeLogParameter(true)).toBe(true)
    expect(sanitizeLogParameter(null)).toBeNull()
  })

  it('redacts an error parameter', () => {
    expect(String(sanitizeLogParameter(new Error(`Basic ${TOKEN}`)))).not.toContain(TOKEN)
  })

  it('still redacts a value that cannot be serialised', () => {
    const circular: Record<string, unknown> = { access_token: TOKEN }
    circular.self = circular

    expect(String(sanitizeLogParameter(circular))).not.toContain(TOKEN)
  })
})

describe('previewSecret', () => {
  it('never includes any part of the secret', () => {
    const preview = previewSecret(TOKEN)

    expect(preview).not.toContain(TOKEN)
    expect(preview).not.toContain(TOKEN.slice(0, 4))
  })

  it('is stable for the same secret and differs for another', () => {
    expect(previewSecret(TOKEN)).toBe(previewSecret(TOKEN))
    expect(previewSecret(TOKEN)).not.toBe(previewSecret(`${TOKEN}x`))
  })

  it('reports the length, which is what catches a truncated paste', () => {
    expect(previewSecret(TOKEN)).toContain(`${TOKEN.length} chars`)
  })

  it('says so plainly when there is no secret', () => {
    expect(previewSecret(undefined)).toBe('(none)')
    expect(previewSecret('')).toBe('(none)')
    expect(previewSecret(null)).toBe('(none)')
  })
})

describe('sanitizeUrl', () => {
  it('drops the query string', () => {
    expect(sanitizeUrl('https://home.nest.com/session?token=secret'))
      .toBe('https://home.nest.com/session')
  })

  it('keeps the path, which names the operation', () => {
    expect(sanitizeUrl('https://home.nest.com/api/0.1/user/5551234/app_launch'))
      .toBe('https://home.nest.com/api/0.1/user/***/app_launch')
  })

  it('redacts a value that will not parse as a URL', () => {
    expect(sanitizeUrl(`not-a-url?access_token=${TOKEN}`)).not.toContain(TOKEN)
  })
})
