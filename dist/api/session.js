"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest Account session, the only authentication path supported.
 *
 * Flow:
 *   1. `GET /session` with `Authorization: Basic <configured access_token>`.
 *   2. Use the `access_token`, `userid`, and `urls.transport_url` from that
 *      response for every subsequent REST and Observe call.
 *
 * Google account sign-in is deliberately not implemented. It requires
 * replaying a browser cookie through Google's own `issueToken` flow, which
 * Google changes without notice and which asks the user to paste a credential
 * covering their entire Google account rather than just their Nest home.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticatedHeaders = authenticatedHeaders;
exports.openSession = openSession;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
const sanitizers_1 = require("../utils/sanitizers");
const http_1 = require("./http");
/**
 * Build the headers Nest expects on a session request.
 *
 * The token is sent twice, as Basic auth and as the `cztoken` cookie, because
 * that is what the Nest web app does and the endpoint is its private backend.
 * Sending only one of the two is not reliably accepted.
 */
function sessionHeaders(accessToken) {
    return {
        Authorization: `Basic ${accessToken}`,
        'User-Agent': settings_1.USER_AGENT,
        cookie: `G_ENABLED_IDPS=google; eu_cookie_accepted=1; viewer-volume=0.5; cztoken=${accessToken}`,
    };
}
/** Standard headers for an authenticated REST call, once a session exists. */
function authenticatedHeaders(session) {
    return {
        'User-Agent': settings_1.USER_AGENT,
        Authorization: `Basic ${session.token}`,
        'X-nl-user-id': session.userId,
        'X-nl-protocol-version': '1',
        'Content-Type': 'application/json',
    };
}
/**
 * Exchange the configured access token for a usable session.
 *
 * @throws {AuthenticationError} When Nest rejects the token.
 * @throws {SessionShapeError} When the response is accepted but omits a field
 *   the plugin needs, which means Nest changed the contract.
 */
async function openSession(options) {
    const { accessToken, endpoints, log } = options;
    if (log.debugEnabled) {
        log.debug(`Opening a Nest session with the configured token ${(0, sanitizers_1.previewSecret)(accessToken)}`);
    }
    const body = await (0, http_1.requestJson)(endpoints.sessionUrl, {
        method: 'GET',
        headers: sessionHeaders(accessToken),
        timeoutMs: settings_1.SESSION_TIMEOUT_MS,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
    });
    const token = typeof body.access_token === 'string' ? body.access_token : undefined;
    // Only a scalar. `String()` accepts anything, so an object would become
    // `'[object Object]'` — truthy, so it passes the missing-field check below and
    // then goes into the app_launch URL, sending the live token to a path Nest
    // will 404. A shape change should raise SessionShapeError, which exists to say
    // "Nest changed its session format; please report this".
    const userId = typeof body.userid === 'string' || typeof body.userid === 'number'
        ? String(body.userid)
        : undefined;
    const transportUrl = typeof body.urls?.transport_url === 'string'
        ? body.urls.transport_url
        : undefined;
    const missing = [];
    if (!token) {
        missing.push('access_token');
    }
    if (!userId) {
        missing.push('userid');
    }
    if (!transportUrl) {
        missing.push('urls.transport_url');
    }
    if (missing.length > 0) {
        throw new errors_1.SessionShapeError(missing);
    }
    // A session whose transport host is not a Nest host would send the token
    // wherever the response says. The value is server-controlled, so it is
    // checked rather than trusted — and the *normalized* form is what gets used,
    // because a query or fragment on the raw string would turn the subscribe path
    // into query data and silently POST to `/` instead.
    const normalizedTransportUrl = assertNestTransportUrl(transportUrl);
    const expiresInSec = typeof body.expires_in === 'number'
        && Number.isFinite(body.expires_in)
        && body.expires_in > 0
        ? body.expires_in
        : undefined;
    if (log.debugEnabled) {
        log.debug(`Nest session established; the session token is ${(0, sanitizers_1.previewSecret)(token)}`
            + `${expiresInSec !== undefined ? ` and expires in ${expiresInSec}s` : ''}`);
    }
    const openedAt = Date.now();
    return {
        token: token,
        userId: userId,
        transportUrl: normalizedTransportUrl,
        openedAt,
        expiresAt: expiresInSec !== undefined ? openedAt + expiresInSec * 1_000 : undefined,
    };
}
/** Hosts the session token may be sent to, beyond the fixed API endpoints. */
const ALLOWED_TRANSPORT_SUFFIXES = ['.nest.com', '.nestlabs.com'];
/**
 * Refuse a transport URL that would send the token off Nest's infrastructure.
 *
 * `transport_url` comes from the session response and is appended to on every
 * subscribe, so without this check the server response alone decides where a
 * live credential is delivered.
 *
 * @returns The normalized `origin + pathname` form, with any query, fragment,
 *   and trailing slash removed, so callers cannot append a path onto something
 *   that is not a path.
 */
function assertNestTransportUrl(transportUrl) {
    let parsed;
    try {
        parsed = new URL(transportUrl);
    }
    catch {
        throw new errors_1.AuthenticationError('The Nest session returned a transport URL that is not a valid URL; refusing to use it.');
    }
    const isHttps = parsed.protocol === 'https:';
    const isNestHost = ALLOWED_TRANSPORT_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix));
    // Port and userinfo are part of where the credential actually goes. A
    // response naming `https://user:pass@sub.nest.com:31337` passes a
    // hostname-only check while redirecting the live session token elsewhere.
    const isDefaultPort = parsed.port === '' || parsed.port === '443';
    const hasUserInfo = parsed.username !== '' || parsed.password !== '';
    if (!isHttps || !isNestHost || !isDefaultPort || hasUserInfo) {
        throw new errors_1.AuthenticationError(`The Nest session returned an unexpected transport host (${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}); refusing to send the session token to it.`);
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}
//# sourceMappingURL=session.js.map