/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Redaction utilities that keep credentials out of logs.
 *
 * A Nest access token is a bearer credential for the whole home: anyone holding
 * it can read every sensor and change every thermostat and smoke alarm setting,
 * with no password and no second factor. Debug logs from a Homebridge instance
 * routinely get pasted into public issue trackers, so redaction here is a real
 * control rather than hygiene theatre.
 *
 * Two design rules follow from that, both learned from defects in sibling
 * plugins:
 *
 * 1. Every secret is declared once, in {@link SECRET_KEYS}, and both the JSON
 *    and `name=value` patterns are generated from it. Maintaining two parallel
 *    lists by hand is how a value ends up redacted in a header but logged
 *    verbatim in a JSON body.
 * 2. Unknown long `name=value` pairs are redacted by exception rather than by
 *    enumeration, so a credential Nest starts issuing under a new name costs a
 *    noisier log rather than a disclosure.
 */

import { scryptSync } from 'node:crypto'

/**
 * Fixed salt for {@link previewSecret} fingerprints.
 *
 * Not a credential. These previews are for log correlation only — never stored
 * or checked like a password. CodeQL's password-hash query only accepts
 * memory-hard KDFs (scrypt/bcrypt/PBKDF2/Argon2) for password-tainted values,
 * so scrypt is used even though a keyed HMAC would otherwise be enough here.
 * Call sites are rare (session diagnostics), so the cost is acceptable.
 */
const SECRET_PREVIEW_SALT = 'homebridge-mynest:secret-preview'

/** A secret, the names it appears under, and the name to show once redacted. */
interface SecretKey {
  /** Every spelling this secret is known to appear under. */
  readonly aliases: readonly string[]
  /** The name written into redacted output. */
  readonly canonical: string
}

/**
 * Every value that must never reach a log, declared once.
 *
 * Adding a secret here covers it in all supported shapes automatically.
 */
const SECRET_KEYS: readonly SecretKey[] = [
  // The session bearer, in every spelling the session and app_launch responses
  // use for it, plus the cookie the web app carries it in.
  { canonical: 'access_token', aliases: ['access_token', 'accessToken', 'cztoken'] },

  // Weave pairing material. Returned alongside the session and equivalent to
  // device-level credentials even though this plugin never uses it.
  { canonical: 'weave_token', aliases: ['weave_token', 'service_config', 'pairing_token'] },

  // Nest's own name for the refresh material on some session shapes.
  { canonical: 'refresh_token', aliases: ['refresh_token', 'refreshToken'] },
]

/**
 * Cookie attributes and cookie names that carry nothing sensitive.
 *
 * Everything else in a cookie header is redacted, so this list failing to
 * mention a new Nest cookie costs a slightly noisier log rather than a
 * disclosed credential.
 */
const NON_SENSITIVE_COOKIE_NAMES: ReadonlySet<string> = new Set([
  // Cookie attributes, which are not name/value pairs at all.
  'path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'version',
  // Preference cookies the web app sets, observed on a live account.
  'g_enabled_idps', 'eu_cookie_accepted', 'viewer-volume',
])

const escapeForPattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Build the redaction rules for one secret.
 *
 * The JSON form must come first. In `"key":"value"` a quote sits between the
 * key and its colon, so no `name=value` pattern can match it, and relying on
 * one is exactly the gap that leaks tokens out of API error bodies.
 */
function rulesForSecret({ canonical, aliases }: SecretKey): Array<{ pattern: RegExp, replacement: string }> {
  const group = aliases.map(escapeForPattern).join('|')

  return [
    { pattern: new RegExp(`"(?:${group})"\\s*:\\s*"[^"]*"`, 'gi'), replacement: `"${canonical}":"***"` },
    { pattern: new RegExp(`\\b(?:${group})\\s*[=:]\\s*"?[^;&\\s"']*`, 'gi'), replacement: `${canonical}=***` },
  ]
}

/**
 * Patterns for sensitive data that must never reach a log.
 *
 * Every pattern is linear with no nested quantifiers, so none is vulnerable to
 * catastrophic backtracking on a large or hostile input.
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp, replacement: string }> = [
  ...SECRET_KEYS.flatMap(rulesForSecret),

  // Whole Cookie/Set-Cookie headers, in JSON and header form. The header form
  // cannot match the JSON one for the same quote-before-colon reason above.
  { pattern: /"(?:set-)?cookie"\s*:\s*"[^"]*"/gi, replacement: '"cookie":"***"' },
  { pattern: /\b(set-)?cookie\s*:\s*[^\n\r]*/gi, replacement: 'cookie: ***' },

  // The session token travels as HTTP Basic auth on every Nest call, so an
  // `Authorization` header logged in full is the token logged in full.
  { pattern: /\bbasic\s+[^\s,"']+/gi, replacement: 'Basic ***' },
  { pattern: /\bbearer\s+[^\s,"']+/gi, replacement: 'Bearer ***' },

  // The account's numeric user id is path-embedded in the app_launch URL. It is
  // not a credential, but it identifies the account across an issue tracker and
  // costs nothing to withhold.
  { pattern: /\/user\/[^/\s"']+/gi, replacement: '/user/***' },
]

/** Two or more `name=value` pairs joined by `;`, i.e. a serialised cookie header. */
const COOKIE_HEADER_SHAPE = /(?:^|\s)[\w.~$-]+=[^;\s]*;\s*[\w.~$-]+=/
const COOKIE_PAIR = /([\w.~$-]+)=([^;\s]+)/g

/**
 * A `name=value` pair whose value is long enough to be a credential.
 *
 * The length floor is what makes this safe to apply to arbitrary text. A lone
 * token carries no `;` to identify it as a cookie, so without a floor the only
 * way to catch it would be to redact every `name=value` in every log line,
 * which would take `frame=2` and `attempt=3` with it and make debugging worse.
 * No credential Nest issues is under sixteen characters; no state value the
 * plugin logs is over it.
 */
const LONG_VALUE_PAIR = /\b([\w.~$-]+)=([\w%./+~-]{16,})/g

/**
 * Redact values the plugin cannot vouch for, by exception rather than by name.
 *
 * The session cookie header is a bare `name=value; name=value` string with no
 * `Cookie:` prefix, so the header rule above never sees it.
 */
function redactUnknownCookies(value: string): string {
  const isCookieHeader = COOKIE_HEADER_SHAPE.test(value)
  const pattern = isCookieHeader ? COOKIE_PAIR : LONG_VALUE_PAIR

  return value.replace(pattern, (match, name: string) =>
    NON_SENSITIVE_COOKIE_NAMES.has(name.toLowerCase()) ? match : `${name}=***`)
}

/** Remove sensitive data from an arbitrary string. */
export function sanitizeString(value: string): string {
  let result = value
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return redactUnknownCookies(result)
}

/** Convert an unknown thrown value into a sanitized, log-safe message. */
export function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    return sanitizeString(err.message)
  }
  if (typeof err === 'string') {
    return sanitizeString(err)
  }
  return sanitizeString(String(err))
}

/**
 * Render a value passed alongside a log message so it cannot leak a secret.
 *
 * Objects are flattened to sanitized JSON rather than handed to the underlying
 * logger intact. Passing an object through untouched means its property values
 * never meet a redaction pattern, and an `access_token` field would print in
 * full.
 */
export function sanitizeLogParameter(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value)
  }
  if (value instanceof Error) {
    return sanitizeError(value)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }

  try {
    return sanitizeString(JSON.stringify(value) ?? String(value))
  } catch {
    // Circular or otherwise unserializable. Fall back to the string form,
    // which is still redacted rather than passed through.
    return sanitizeString(String(value))
  }
}

/**
 * Render a secret as a short, non-reversible fingerprint for diagnostics.
 *
 * Enough to tell "the token changed" or "the token is empty" apart in a log.
 * Never a slice of the secret itself: disclosing even four characters of a
 * credential buys no diagnostic power that a fingerprint does not, and a log
 * is not a place to spend any of a secret's entropy.
 */
export function previewSecret(secret: string | undefined | null): string {
  if (!secret) {
    return '(none)'
  }

  const cached = previewCache.get(secret)
  if (cached !== undefined) {
    return cached
  }

  const fingerprint = scryptSync(secret, SECRET_PREVIEW_SALT, 4).toString('hex')
  const preview = `(${secret.length} chars, scrypt:${fingerprint})`

  // Bounded: keyed by the secret itself, and a plugin only ever sees a couple
  // (the configured token and the session token it is exchanged for).
  if (previewCache.size >= MAX_PREVIEW_CACHE) {
    previewCache.clear()
  }
  previewCache.set(secret, preview)

  return preview
}

/**
 * Memoised fingerprints.
 *
 * scrypt at default parameters allocates ~16 MB and blocks for tens of
 * milliseconds. That is acceptable once per token but not once per session
 * open, and a debug-enabled outage produces a burst of those — each one
 * stalling the event loop and delaying every HomeKit response.
 */
const MAX_PREVIEW_CACHE = 8
const previewCache = new Map<string, string>()

/**
 * Strip the query string from a URL for logging.
 *
 * Path segments are kept because Nest's paths name the operation, which is the
 * useful part of a request log; the user id embedded in `app_launch` is
 * redacted by {@link sanitizeString}.
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return sanitizeString(`${parsed.origin}${parsed.pathname}`)
  } catch {
    return sanitizeString(url)
  }
}
