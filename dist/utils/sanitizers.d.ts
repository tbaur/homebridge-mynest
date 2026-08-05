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
/** Remove sensitive data from an arbitrary string. */
export declare function sanitizeString(value: string): string;
/** Convert an unknown thrown value into a sanitized, log-safe message. */
export declare function sanitizeError(err: unknown): string;
/**
 * Render a value passed alongside a log message so it cannot leak a secret.
 *
 * Objects are flattened to sanitized JSON rather than handed to the underlying
 * logger intact. Passing an object through untouched means its property values
 * never meet a redaction pattern, and an `access_token` field would print in
 * full.
 */
export declare function sanitizeLogParameter(value: unknown): unknown;
/**
 * Render a secret as a short, non-reversible fingerprint for diagnostics.
 *
 * Enough to tell "the token changed" or "the token is empty" apart in a log.
 * Never a slice of the secret itself: disclosing even four characters of a
 * credential buys no diagnostic power that a fingerprint does not, and a log
 * is not a place to spend any of a secret's entropy.
 */
export declare function previewSecret(secret: string | undefined | null): string;
/**
 * Strip the query string from a URL for logging.
 *
 * Path segments are kept because Nest's paths name the operation, which is the
 * useful part of a request log; the user id embedded in `app_launch` is
 * redacted by {@link sanitizeString}.
 */
export declare function sanitizeUrl(url: string): string;
