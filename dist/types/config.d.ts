/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Platform configuration, as written by the user and as resolved.
 */
/** The platform block exactly as it appears in the Homebridge config file. */
export interface MyNestPlatformConfig {
    platform: string;
    name?: string;
    /**
     * Nest Account `access_token`, copied from https://home.nest.com/session.
     *
     * This plugin deliberately supports only Nest Account tokens. Google account
     * sign-in requires replaying a browser cookie through Google's own auth flow,
     * which breaks without warning and asks users to paste a credential far more
     * powerful than this one.
     */
    accessToken?: unknown;
    /** Talk to Nest's field-test environment instead of production. */
    fieldTest?: unknown;
    /**
     * Allow HomeKit to change thermostat setpoints and modes via Nest
     * BatchUpdateState. Off by default (opt-in) so upgrades do not start driving
     * HVAC until the operator enables control. Target characteristics stay
     * writable for Home presentation either way.
     */
    allowThermostatControl?: unknown;
    /**
     * Publish a house-wide Switch that turns Eco on/off for every thermostat.
     * Requires `allowThermostatControl` for writes. Off by default.
     */
    exposeGlobalEcoSwitch?: unknown;
    /** Publish an occupancy sensor for each Nest Protect that reports one. */
    exposeProtectOccupancy?: unknown;
    /** Publish the temperature and humidity a Nest Protect measures. */
    exposeProtectTemperature?: unknown;
    /** Nest device IDs or serial numbers to leave out of HomeKit entirely. */
    ignoredDeviceIds?: unknown;
    /**
     * Seconds between opt-in health heartbeats in the Homebridge log.
     *
     * `0` (default) disables them. A non-zero value below 30 is raised to 30;
     * the maximum is 86400 (24h).
     */
    diagnosticsInterval?: unknown;
    /**
     * When diagnostics are enabled, also emit a machine-readable JSON line
     * alongside each human-readable health report.
     */
    structuredLogs?: unknown;
    /** Emit verbose diagnostics, including per-trait Observe updates. */
    debug?: unknown;
}
/** Configuration after validation, with every value present and in range. */
export interface ResolvedConfig {
    /**
     * Instance name, normalised to {@link PLATFORM_NAME} when unset.
     *
     * Homebridge itself applies this to log lines and to the child-bridge name;
     * the plugin only resolves it so the value it reports is the one in effect.
     */
    name: string;
    accessToken: string;
    fieldTest: boolean;
    allowThermostatControl: boolean;
    exposeGlobalEcoSwitch: boolean;
    exposeProtectOccupancy: boolean;
    exposeProtectTemperature: boolean;
    /** Matched against both the Observe resource id and the REST serial number. */
    ignoredDeviceIds: ReadonlySet<string>;
    /** Seconds between health heartbeats; `0` disables. */
    diagnosticsInterval: number;
    structuredLogs: boolean;
    debug: boolean;
}
/** Outcome of validating user configuration. */
export interface ConfigValidationResult {
    config: ResolvedConfig;
    /** Non-fatal problems worth telling the user about. */
    warnings: string[];
}
//# sourceMappingURL=config.d.ts.map