"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Configuration validation.
 *
 * The checks here are shaped by what users actually paste into this field.
 * `access_token` sits in a JSON blob next to half a dozen other tokens, and
 * getting the wrong one produces an opaque HTTP 401 at runtime with nothing
 * pointing back at the config. Catching the recognisable mistakes at startup
 * is worth more than a generic "required field" error.
 *
 * Log copy uses the Homebridge UI titles (Title Case), not JSON keys.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateConfig = validateConfig;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
/**
 * Shortest plausible Nest access token.
 *
 * Real ones run to well over a hundred characters. Anything this short is a
 * truncated copy/paste, which otherwise fails as an unexplained 401. Matches
 * `config.schema.json` `minLength` so the UI and runtime agree.
 */
const MIN_TOKEN_LENGTH = 32;
/**
 * A JSON Web Token, which is what a Google account sign-in yields.
 *
 * Users following a guide written for the Google auth path arrive with one of
 * these. It is not a Nest Account token and will never work here, so saying so
 * plainly beats letting Nest answer 401.
 */
const JWT_PATTERN = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./;
/**
 * Google's OAuth access tokens, which users also reach for by mistake.
 */
const GOOGLE_TOKEN_PATTERN = /^ya29\./;
/** Shortest allowed diagnostics heartbeat when the feature is enabled. */
const MIN_DIAGNOSTICS_INTERVAL_SEC = 30;
/** Longest allowed diagnostics heartbeat. */
const MAX_DIAGNOSTICS_INTERVAL_SEC = 3600;
function parseBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
/**
 * Validate the Nest access token.
 *
 * @throws {ConfigurationError} When the value is missing or is recognisably
 *   the wrong kind of credential.
 */
function parseAccessToken(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new errors_1.ConfigurationError(`Access Token is required in the ${settings_1.PLATFORM_NAME} platform config. Sign in at https://home.nest.com/session and copy the Nest Account access_token.`);
    }
    const token = value.trim();
    if (JWT_PATTERN.test(token)) {
        throw new errors_1.ConfigurationError('Access Token looks like a Google account sign-in token (JWT). Use a Nest Account token from https://home.nest.com/session instead.');
    }
    if (GOOGLE_TOKEN_PATTERN.test(token)) {
        throw new errors_1.ConfigurationError('Access Token looks like a Google OAuth token (ya29.). Use a Nest Account token from https://home.nest.com/session instead.');
    }
    if (token.length < MIN_TOKEN_LENGTH) {
        throw new errors_1.ConfigurationError(`Access Token is shorter than ${MIN_TOKEN_LENGTH} characters and is probably truncated; paste the full value from https://home.nest.com/session.`);
    }
    return token;
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
    if (value > MAX_DIAGNOSTICS_INTERVAL_SEC) {
        throw new errors_1.ConfigurationError(`Diagnostics Interval cannot exceed ${MAX_DIAGNOSTICS_INTERVAL_SEC} seconds`);
    }
    if (value < MIN_DIAGNOSTICS_INTERVAL_SEC) {
        warnings.push(`Diagnostics Interval was raised from ${value} to ${MIN_DIAGNOSTICS_INTERVAL_SEC} seconds.`);
        return MIN_DIAGNOSTICS_INTERVAL_SEC;
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
        accessToken: parseAccessToken(raw.accessToken),
        fieldTest: parseBoolean(raw.fieldTest, false),
        allowThermostatControl: parseBoolean(raw.allowThermostatControl, false),
        exposeGlobalEcoSwitch: parseBoolean(raw.exposeGlobalEcoSwitch, false),
        exposeProtectOccupancy: parseBoolean(raw.exposeProtectOccupancy, true),
        exposeProtectTemperature: parseBoolean(raw.exposeProtectTemperature, false),
        ignoredDeviceIds: parseIgnoredIds(raw.ignoredDeviceIds, warnings),
        diagnosticsInterval: parseDiagnosticsInterval(raw.diagnosticsInterval, warnings),
        structuredLogs: parseBoolean(raw.structuredLogs, false),
        debug: parseBoolean(raw.debug, false),
    };
    if (config.fieldTest) {
        warnings.push('Field Test option points the plugin at Nest\'s field-test servers. Leave it off unless you were told otherwise.');
    }
    return { config, warnings };
}
//# sourceMappingURL=validators.js.map