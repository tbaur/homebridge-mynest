"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Plugin-wide constants and Nest endpoints.
 *
 * Nest publishes no consumer API for these paths and no documentation. Every
 * value here was confirmed empirically against a live account with the
 * nest-probe kit (reads by default; probe 12 dry-runs BatchUpdateState encode,
 * with optional operator `--confirm` for a live POST), and each one that looks
 * arbitrary carries a comment explaining why it is what it is. Treat this file
 * as the record of what the service actually does, because nothing external
 * will tell you when it changes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SETPOINT_STEP_C = exports.MAX_SETPOINT_C = exports.MIN_SETPOINT_C = exports.PROTECT_OCCUPANCY_HOLD_OFF_SEC = exports.REDISCOVERY_INTERVAL_MS = exports.MAX_REQUEST_ATTEMPTS = exports.SESSION_REFRESH_MS = exports.FORBIDDEN_FATAL_THRESHOLD = exports.OBSERVE_SNAPSHOT_SETTLE_MS = exports.OBSERVE_STARTUP_WARN_MS = exports.MIN_SUBSCRIBE_CYCLE_MS = exports.RECONNECT_MAX_MS = exports.RECONNECT_BASE_MS = exports.OBSERVE_IDLE_TIMEOUT_MS = exports.OBSERVE_PING_INTERVAL_MS = exports.OBSERVE_SESSION_MS = exports.REST_ALARM_FEED_STALE_MS = exports.SUBSCRIBE_TIMEOUT_MS = exports.APP_LAUNCH_TIMEOUT_MS = exports.SESSION_TIMEOUT_MS = exports.APP_LAUNCH_BUCKET_TYPES = exports.WEB_APP_VERSION = exports.USER_AGENT = exports.MANUFACTURER = exports.HAP_TILE_EPOCH = exports.UUID_PREFIX = exports.PLATFORM_NAME = exports.PLUGIN_NAME = void 0;
exports.resolveEndpoints = resolveEndpoints;
exports.appLaunchUrl = appLaunchUrl;
/** Name used to register the plugin with Homebridge (must match package.json name). */
exports.PLUGIN_NAME = 'homebridge-mynest';
/** Platform identifier referenced in the user's Homebridge config. */
exports.PLATFORM_NAME = 'MyNest';
/** Prefix used when generating stable HAP accessory UUIDs. */
exports.UUID_PREFIX = 'mynest-';
/**
 * Bump when HomeKit presentation must be force-recreated (category / required
 * thermostat characteristics). Cached accessories with a lower epoch are
 * unregistered and registered fresh so Apple Home shows room tiles again —
 * `updatePlatformAccessories` alone does not refresh a stuck No Response tile.
 */
exports.HAP_TILE_EPOCH = 1;
/** Reported as the HomeKit accessory manufacturer. */
exports.MANUFACTURER = 'Nest';
/**
 * Browser user agent sent on every request.
 *
 * These endpoints are the Nest web app's own backend and reject clients that
 * do not look like a browser.
 */
exports.USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/77.0.3865.120 Safari/537.36';
/**
 * Version string the Nest web app sends on Observe requests.
 *
 * The gateway uses it to decide which trait schema it will serve. Bumping it
 * blind risks receiving traits this plugin cannot decode, so it stays pinned
 * to a version confirmed working against a live account.
 */
exports.WEB_APP_VERSION = 'NlAppSDKVersion/8.15.0 NlSchemaVersion/2.1.20-87-gce5742894';
const PRODUCTION_ENDPOINTS = {
    apiHostname: 'home.nest.com',
    sessionUrl: 'https://home.nest.com/session',
    grpcOrigin: 'https://grpc-web.production.nest.com',
    observePath: '/nestlabs.gateway.v2.GatewayService/Observe',
    batchUpdatePath: '/nestlabs.gateway.v1.TraitBatchApi/BatchUpdateState',
    subscribePath: '/v5/subscribe',
};
const FIELD_TEST_ENDPOINTS = {
    apiHostname: 'home.ft.nest.com',
    sessionUrl: 'https://home.ft.nest.com/session',
    grpcOrigin: 'https://grpc-web.ft.nest.com',
    observePath: PRODUCTION_ENDPOINTS.observePath,
    batchUpdatePath: PRODUCTION_ENDPOINTS.batchUpdatePath,
    subscribePath: PRODUCTION_ENDPOINTS.subscribePath,
};
/** Resolve the endpoint set for the configured environment. */
function resolveEndpoints(isFieldTest) {
    return isFieldTest ? FIELD_TEST_ENDPOINTS : PRODUCTION_ENDPOINTS;
}
/** Build the `app_launch` URL, which is scoped to one user id. */
function appLaunchUrl(endpoints, userId) {
    return `https://${endpoints.apiHostname}/api/0.1/user/${encodeURIComponent(userId)}/app_launch`;
}
/**
 * Bucket types requested from `app_launch`.
 *
 * Nest returns only the buckets the account actually has, so asking for a type
 * the home does not own is free. `device` and `shared` are requested even
 * though a protobuf-only account returns neither: an account with an older
 * thermostat does return them, and they are the cheaper read when present.
 */
exports.APP_LAUNCH_BUCKET_TYPES = [
    'buckets',
    'structure',
    'shared',
    'topaz',
    'device',
    'rcs_settings',
    'kryptonite',
    'where',
];
// ---------------------------------------------------------------------------
// Request tuning
// ---------------------------------------------------------------------------
/** Hard ceiling on opening a session. Never wait on Nest indefinitely. */
exports.SESSION_TIMEOUT_MS = 40_000;
/** Hard ceiling on an `app_launch`, which returns the whole account at once. */
exports.APP_LAUNCH_TIMEOUT_MS = 120_000;
/**
 * How long to hold a REST `subscribe` long-poll open before aborting it.
 *
 * Nest parks the request until something changes, so the client decides the
 * cycle length. Two minutes matches what Nest's own web app uses; aborting is
 * the normal outcome on a quiet home, not a failure.
 */
exports.SUBSCRIBE_TIMEOUT_MS = 120_000;
/**
 * How long after the last successful REST cycle (including idle subscribe)
 * Protect smoke/CO may still be treated as live from cached topaz.
 *
 * Must exceed {@link SUBSCRIBE_TIMEOUT_MS}: a quiet house parks the long-poll
 * for the full client timeout without being unhealthy. Beyond this window,
 * tiles stay in HomeKit but are marked inactive/faulted — never a live frozen
 * all-clear, and never torn down (rooms/automations keep their targets).
 */
exports.REST_ALARM_FEED_STALE_MS = exports.SUBSCRIBE_TIMEOUT_MS + 60_000;
/**
 * How long a single Observe connection is held before being recycled.
 *
 * Nest drops these streams on its own schedule, and a stream that has silently
 * stopped delivering is indistinguishable from a quiet home. Recycling on a
 * known cadence turns an unbounded stall into a bounded one.
 */
exports.OBSERVE_SESSION_MS = 30 * 60_000;
/** Interval between HTTP/2 pings that keep the Observe stream from idling out. */
exports.OBSERVE_PING_INTERVAL_MS = 60_000;
/**
 * Longest silence tolerated on an Observe stream before it is recycled.
 *
 * A live account emits at minimum a periodic trait refresh well inside this
 * window. Exceeding it means the socket is up but the stream is dead, which is
 * the failure mode that leaves HomeKit showing stale temperatures indefinitely.
 */
exports.OBSERVE_IDLE_TIMEOUT_MS = 10 * 60_000;
/** Delay before the first reconnect attempt after a transport drops. */
exports.RECONNECT_BASE_MS = 5_000;
/** Upper bound on the reconnect backoff. */
exports.RECONNECT_MAX_MS = 5 * 60_000;
/**
 * Floor on how fast the REST subscribe loop may cycle on a success path.
 *
 * Nest can answer a long-poll with an empty 200, or convert a 502/504 into an
 * idle result, in milliseconds. Without a floor every installed plugin becomes
 * an unthrottled request loop against a degraded edge. Failures already wait
 * via reconnect backoff; this bound covers the non-throwing path.
 */
exports.MIN_SUBSCRIBE_CYCLE_MS = 2_000;
/**
 * How long to wait after start before warning that Observe has produced no frames.
 *
 * Thermostats are Observe-only on modern accounts. Silence at info level here
 * leaves HomeKit empty while the log only says "Connected to Nest".
 */
exports.OBSERVE_STARTUP_WARN_MS = 60_000;
/**
 * Quiet period after the last Observe trait of a reconnect before treating the
 * opening burst as a complete device snapshot.
 *
 * Nest delivers the full inventory as many frames in quick succession, then
 * goes quiet until a real patch. Waiting slightly longer than the platform's
 * update coalesce window avoids pruning mid-burst when a late frame arrives.
 */
exports.OBSERVE_SNAPSHOT_SETTLE_MS = 750;
/**
 * Consecutive HTTP 403 responses on one transport before that loop gives up.
 *
 * A single 403 on a Nest edge host can be a WAF / bot-detection blip against
 * the pinned user agent. Counters are per-transport so REST blips cannot kill
 * a healthy Observe stream (and vice versa). The plugin only treats the token
 * as dead when *both* loops have exhausted this budget. 401 always means the
 * token is rejected immediately.
 */
exports.FORBIDDEN_FATAL_THRESHOLD = 3;
/**
 * How long a session is reused before it is re-established.
 *
 * Nest reports an `expires_in` far longer than this, but a token that has been
 * revoked server-side keeps working until first refusal. Re-opening on a fixed
 * cadence bounds how long the plugin can run on a dead session.
 */
exports.SESSION_REFRESH_MS = 6 * 60 * 60_000;
/** Maximum attempts for a single REST request before surfacing the failure. */
exports.MAX_REQUEST_ATTEMPTS = 3;
/**
 * How often to re-run `app_launch` to pick up devices added or removed.
 *
 * The subscribe loop reports changes to buckets it already knows about, so it
 * cannot notice a brand-new device. Hourly keeps a rare event reasonably fresh
 * without spending requests on a list that almost never changes.
 */
exports.REDISCOVERY_INTERVAL_MS = 60 * 60 * 1_000;
// ---------------------------------------------------------------------------
// Device behaviour
// ---------------------------------------------------------------------------
/**
 * Nest's own occupancy hold-off for a Protect, in seconds.
 *
 * A Protect does not report motion. It reports `auto_away`, which Nest flips
 * only after roughly ten minutes with no activity, and clears on the first
 * detection. HomeKit occupancy is therefore ten-minute-resolution presence,
 * not motion, and the README says so plainly. Exposed here so the value used
 * in log messages and documentation has a single source.
 */
exports.PROTECT_OCCUPANCY_HOLD_OFF_SEC = 600;
/** Floor on the thermostat setpoint HomeKit may request, in Celsius. */
exports.MIN_SETPOINT_C = 9;
/** Ceiling on the thermostat setpoint HomeKit may request, in Celsius. */
exports.MAX_SETPOINT_C = 32;
/** Granularity of thermostat setpoints in Celsius, matching Nest's own UI. */
exports.SETPOINT_STEP_C = 0.5;
//# sourceMappingURL=settings.js.map