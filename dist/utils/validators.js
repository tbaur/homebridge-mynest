"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Configuration validation.
 *
 * Both sign-in values are copied by hand from a browser's developer tools, so
 * the checks here are shaped by the mistakes that copy makes: the wrong
 * request's URL, a header name pasted along with its value, or a truncated
 * value. Each otherwise fails at runtime as an unexplained Google error.
 *
 * Log copy uses the Homebridge UI titles (Title Case), not JSON keys.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateConfig = validateConfig;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
const SETUP_HINT = 'See docs/AUTH.md for how to copy it.';
/** A cookie header always carries Google's session cookie under this name. */
const REQUIRED_COOKIE = 'SID';
function parseBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
/**
 * Validate the issueToken URL.
 *
 * The URL is fetched with the account's cookies attached, so only Google's
 * own sign-in endpoint is accepted. Anything else would send the cookies to
 * whatever host the config names.
 *
 * @throws {ConfigurationError} When the value is missing or is not Google's
 *   issueToken endpoint.
 */
function parseIssueToken(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new errors_1.ConfigurationError(`Issue Token URL is required. ${SETUP_HINT}`);
    }
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw new errors_1.ConfigurationError(`Issue Token URL is not a valid URL. ${SETUP_HINT}`);
    }
    const isGoogleEndpoint = url.protocol === 'https:'
        && url.hostname === settings_1.GOOGLE_ISSUE_TOKEN_HOST
        && (url.port === '' || url.port === '443')
        && url.username === ''
        && url.password === ''
        && url.pathname === settings_1.GOOGLE_ISSUE_TOKEN_PATH;
    if (!isGoogleEndpoint) {
        throw new errors_1.ConfigurationError(`Issue Token URL must start with https://${settings_1.GOOGLE_ISSUE_TOKEN_HOST}${settings_1.GOOGLE_ISSUE_TOKEN_PATH}. ${SETUP_HINT}`);
    }
    if (url.searchParams.get('action') !== 'issueToken') {
        throw new errors_1.ConfigurationError(`Issue Token URL is from a different request; copy the one containing action=issueToken. ${SETUP_HINT}`);
    }
    return url.toString();
}
/**
 * Validate the Google cookie header.
 *
 * @throws {ConfigurationError} When the value is missing or is not a cookie
 *   header from a signed-in Google session.
 */
function parseCookies(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new errors_1.ConfigurationError(`Cookies are required. ${SETUP_HINT}`);
    }
    const cookies = value.trim().replace(/^cookie:\s*/i, '');
    const names = cookies.split(';').map((pair) => pair.split('=')[0]?.trim());
    if (!names.includes(REQUIRED_COOKIE)) {
        throw new errors_1.ConfigurationError(`Cookies do not include Google's ${REQUIRED_COOKIE} cookie; copy the whole Cookie header from the oauth2/iframe request. ${SETUP_HINT}`);
    }
    return cookies;
}
/**
 * Parse the diagnostics heartbeat interval.
 *
 * `0` (or omitted) disables emission. Sub-floor positive values are raised to
 * the minimum rather than rejected, matching sibling plugins.
 */
function parseDiagnosticsInterval(value, warnings) {
    if (value === undefined || value === null) {
        return 0;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new errors_1.ConfigurationError('Diagnostics Interval must be a number of seconds');
    }
    if (value === 0) {
        return 0;
    }
    if (value < 0) {
        throw new errors_1.ConfigurationError('Diagnostics Interval cannot be negative');
    }
    if (value > settings_1.MAX_DIAGNOSTICS_INTERVAL_SEC) {
        throw new errors_1.ConfigurationError(`Diagnostics Interval cannot exceed ${settings_1.MAX_DIAGNOSTICS_INTERVAL_SEC} seconds`);
    }
    if (value < settings_1.MIN_DIAGNOSTICS_INTERVAL_SEC) {
        warnings.push(`Diagnostics Interval was raised from ${value} to ${settings_1.MIN_DIAGNOSTICS_INTERVAL_SEC} seconds.`);
        return settings_1.MIN_DIAGNOSTICS_INTERVAL_SEC;
    }
    return value;
}
function parseIgnoredIds(value, warnings) {
    if (value === undefined || value === null) {
        return new Set();
    }
    if (!Array.isArray(value)) {
        warnings.push('Ignored Device IDs must be a list of device IDs; ignoring it');
        return new Set();
    }
    // Normalised so a user may paste either the Observe form (`DEVICE_18B4…`) or
    // the bare serial that the REST buckets and the Nest app show.
    return new Set(value
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.trim().replace(/^DEVICE_/i, '').toUpperCase())
        .filter((entry) => entry.length > 0));
}
/**
 * Validate and normalise the user's platform configuration.
 *
 * @throws {ConfigurationError} When a required value is missing or unusable.
 */
function validateConfig(raw) {
    const warnings = [];
    const config = {
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : settings_1.PLATFORM_NAME,
        issueToken: parseIssueToken(raw.issueToken),
        cookies: parseCookies(raw.cookies),
        fieldTest: parseBoolean(raw.fieldTest, false),
        allowThermostatControl: parseBoolean(raw.allowThermostatControl, false),
        exposeGlobalEcoSwitch: parseBoolean(raw.exposeGlobalEcoSwitch, false),
        exposeProtectOccupancy: parseBoolean(raw.exposeProtectOccupancy, true),
        exposeProtectTemperature: parseBoolean(raw.exposeProtectTemperature, false),
        ignoredDeviceIds: parseIgnoredIds(raw.ignoredDeviceIds, warnings),
        diagnosticsInterval: parseDiagnosticsInterval(raw.diagnosticsInterval, warnings),
        structuredLogs: parseBoolean(raw.structuredLogs, false),
        pagerdutySignals: parseBoolean(raw.pagerdutySignals, false),
        debug: parseBoolean(raw.debug, false),
    };
    if (config.fieldTest) {
        warnings.push('Field Test option points the plugin at Nest\'s field-test servers. Leave it off unless you were told otherwise.');
    }
    return { config, warnings };
}
