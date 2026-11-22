"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Google account sign-in, producing Nest tokens on demand.
 *
 * Flow, repeated before each token expires:
 *   1. `GET` the configured issueToken URL with the account's Google cookies.
 *      Google answers with a short-lived OAuth access token.
 *   2. `POST` that token to Nest's auth proxy (`issue_jwt`), which answers with
 *      a Nest token and its expiry.
 *   3. The caller opens a Nest session with the Nest token (see `session.ts`).
 *
 * Google refreshes some of its cookies on every sign-in, the same way it does
 * in a browser. Those are merged back in and handed to a {@link CookieStore},
 * so the next sign-in, including the first one after a restart, presents what
 * Google last issued.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleAuth = void 0;
exports.parseCookieHeader = parseCookieHeader;
exports.formatCookieHeader = formatCookieHeader;
exports.mergeSetCookies = mergeSetCookies;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
const sanitizers_1 = require("../utils/sanitizers");
const http_1 = require("./http");
/**
 * Parse a `Cookie` header into an ordered name → value map.
 *
 * Order is kept so a merged header reads the same as the browser's did.
 */
function parseCookieHeader(header) {
    const jar = new Map();
    for (const pair of header.split(';')) {
        const equals = pair.indexOf('=');
        if (equals <= 0) {
            continue;
        }
        const name = pair.slice(0, equals).trim();
        if (name) {
            jar.set(name, pair.slice(equals + 1).trim());
        }
    }
    return jar;
}
/** Serialise a cookie map back into a `Cookie` header. */
function formatCookieHeader(jar) {
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}
/**
 * Apply `Set-Cookie` headers to a cookie header.
 *
 * A cookie whose value is empty, whose `Max-Age` is zero or less, or whose
 * `Expires` is in the past is removed, which is how a server deletes one.
 *
 * @returns The merged header, or the input unchanged when nothing applied.
 */
function mergeSetCookies(header, setCookies, now = Date.now()) {
    const jar = parseCookieHeader(header);
    let isChanged = false;
    for (const setCookie of setCookies) {
        const [pair = '', ...attributes] = setCookie.split(';');
        const equals = pair.indexOf('=');
        if (equals <= 0) {
            continue;
        }
        const name = pair.slice(0, equals).trim();
        const value = pair.slice(equals + 1).trim();
        const isDeleted = value === '' || attributes.some((attribute) => {
            const [key = '', raw = ''] = attribute.split('=').map((part) => part.trim());
            if (key.toLowerCase() === 'max-age') {
                return Number(raw) <= 0;
            }
            if (key.toLowerCase() === 'expires') {
                const expires = Date.parse(raw);
                return Number.isFinite(expires) && expires <= now;
            }
            return false;
        });
        if (isDeleted) {
            isChanged = jar.delete(name) || isChanged;
        }
        else if (jar.get(name) !== value) {
            jar.set(name, value);
            isChanged = true;
        }
    }
    return isChanged ? formatCookieHeader(jar) : header;
}
/** Parse a JSON body, reporting a non-JSON body as the endpoint's fault. */
function parseJson(url, response) {
    try {
        return JSON.parse(response.text);
    }
    catch (error) {
        throw new errors_1.ApiParseError(`${(0, sanitizers_1.sanitizeUrl)(url)} returned HTTP ${response.status} with a body that is not JSON`, { cause: error instanceof Error ? error : undefined });
    }
}
/** Signs in to the Google account and exchanges the result for Nest tokens. */
class GoogleAuth {
    #options;
    #cookies;
    constructor(options) {
        this.#options = options;
        this.#cookies = options.store?.load(options.cookies) ?? options.cookies;
    }
    /**
     * Sign in and return a fresh Nest token.
     *
     * @throws {AuthenticationError} When Google rejects the cookies or Nest
     *   rejects the Google token. Signing in again would be refused too.
     */
    async mintToken(signal) {
        const googleToken = await this.#issueGoogleToken(signal);
        const token = await this.#issueNestToken(googleToken, signal);
        if (this.#options.log.debugEnabled) {
            const minutes = Math.round((token.expiresAt - Date.now()) / 60_000);
            this.#options.log.debug(`Signed in with Google; Nest token ${(0, sanitizers_1.previewSecret)(token.value)} expires in ${minutes} min`);
        }
        return token;
    }
    async #issueGoogleToken(signal) {
        const url = this.#options.issueToken;
        const response = await (0, http_1.sendRequest)(url, {
            method: 'GET',
            headers: {
                'User-Agent': settings_1.GOOGLE_USER_AGENT,
                'Sec-Fetch-Mode': 'cors',
                'X-Requested-With': 'XmlHttpRequest',
                Referer: 'https://accounts.google.com/o/oauth2/iframe',
                cookie: this.#cookies,
            },
            timeoutMs: settings_1.GOOGLE_SIGN_IN_TIMEOUT_MS,
            fetchImpl: this.#options.fetchImpl,
            signal,
        });
        this.#applySetCookies(response.headers);
        if (response.status === 400 || response.status === 401 || response.status === 403) {
            throw new errors_1.AuthenticationError(undefined, { status: response.status });
        }
        if (response.status >= 400) {
            throw (0, errors_1.createApiError)(response.status, `${(0, sanitizers_1.sanitizeUrl)(url)} returned HTTP ${response.status}`);
        }
        const body = parseJson(url, response);
        if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
            // Google answers a signed-out or expired cookie with HTTP 200 and an
            // `error` field such as "USER_LOGGED_OUT".
            const reason = typeof body.error === 'string' ? ` (${(0, sanitizers_1.sanitizeString)(body.error)})` : '';
            throw new errors_1.AuthenticationError(`Google rejected the sign-in${reason}. Copy a new Issue Token URL and Cookies as described in docs/AUTH.md.`, { status: 401 });
        }
        return body.access_token;
    }
    async #issueNestToken(googleToken, signal) {
        const response = await (0, http_1.sendRequest)(settings_1.NEST_ISSUE_JWT_URL, {
            method: 'POST',
            headers: {
                'User-Agent': settings_1.GOOGLE_USER_AGENT,
                Authorization: `Bearer ${googleToken}`,
                'Content-Type': 'application/json',
                Referer: 'https://home.nest.com/',
                Origin: 'https://home.nest.com',
            },
            body: JSON.stringify({
                embed_google_oauth_access_token: true,
                expire_after: `${settings_1.NEST_TOKEN_LIFETIME_SEC}s`,
                google_oauth_access_token: googleToken,
                policy_id: 'authproxy-oauth-policy',
            }),
            timeoutMs: settings_1.GOOGLE_SIGN_IN_TIMEOUT_MS,
            fetchImpl: this.#options.fetchImpl,
            signal,
        });
        if (response.status === 400) {
            throw new errors_1.AuthenticationError(`Nest would not issue a token for this Google account (HTTP 400). Make sure the account is an admin of the home, then copy a new Issue Token URL and Cookies as described in docs/AUTH.md.`, { status: 400 });
        }
        if (response.status >= 400) {
            throw (0, errors_1.createApiError)(response.status, `${(0, sanitizers_1.sanitizeUrl)(settings_1.NEST_ISSUE_JWT_URL)} returned HTTP ${response.status}`);
        }
        const body = parseJson(settings_1.NEST_ISSUE_JWT_URL, response);
        if (typeof body.jwt !== 'string' || body.jwt.length === 0) {
            throw new errors_1.ApiParseError(`${(0, sanitizers_1.sanitizeUrl)(settings_1.NEST_ISSUE_JWT_URL)} returned no Nest token`);
        }
        const now = Date.now();
        const stated = typeof body.claims?.expirationTime === 'string'
            ? Date.parse(body.claims.expirationTime)
            : Number.NaN;
        const expiresAt = Number.isFinite(stated) && stated > now
            ? stated
            : now + settings_1.NEST_TOKEN_LIFETIME_SEC * 1_000;
        return { value: body.jwt, expiresAt };
    }
    #applySetCookies(headers) {
        const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
        if (setCookies.length === 0) {
            return;
        }
        const merged = mergeSetCookies(this.#cookies, setCookies);
        if (merged === this.#cookies) {
            return;
        }
        this.#cookies = merged;
        this.#options.store?.save(this.#options.cookies, merged);
    }
}
exports.GoogleAuth = GoogleAuth;
