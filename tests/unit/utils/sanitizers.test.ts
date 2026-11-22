/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Keeping credentials out of logs.
 *
 * The Google cookies sign in to the whole Google account, and every token the
 * plugin derives from them reads every sensor and changes every thermostat in
 * the home. Homebridge debug logs get pasted into public issue trackers
 * routinely. These tests cover each shape the credentials are known to travel in.
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
    for (const key of [
      'access_token', 'accessToken', 'google_oauth_access_token', 'id_token', 'jwt',
      'issueToken', 'issue_token', 'cookies', 'refresh_token', 'refreshToken',
    ]) {
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
    expect(sanitizeString(`Cookie: SID=${TOKEN}; other=1`)).not.toContain(TOKEN)
    expect(sanitizeString(`{"cookie":"SID=${TOKEN}"}`)).not.toContain(TOKEN)
    expect(sanitizeString(`Set-Cookie: SID=${TOKEN}; Path=/`)).not.toContain(TOKEN)
  })

  it('redacts every value in a bare cookie string with no header prefix', () => {
    // This is the shape the configured Cookies take.
    const cookies = `SID=${TOKEN}; HSID=short; NID=1`

    const result = sanitizeString(cookies)

    expect(result).toBe('SID=***; HSID=***; NID=***')
  })

  it('redacts bare Google OAuth tokens and Nest tokens', () => {
    expect(sanitizeString(`got ya29.${TOKEN} back`)).toBe('got ya29.*** back')
    expect(sanitizeString(`got g.0.${TOKEN} back`)).toBe('got g.0.*** back')
  })

  it('redacts the account email in the Issue Token URL and elsewhere', () => {
    expect(sanitizeString('login_hint=user%40example.com&client_id=1')).not.toContain('example.com')
    expect(sanitizeString('signed in as user@example.com')).toBe('signed in as ***@***')
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
    expect(sanitizeError(`SID=${TOKEN}`)).not.toContain(TOKEN)
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
