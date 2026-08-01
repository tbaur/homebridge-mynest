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
/** Name used to register the plugin with Homebridge (must match package.json name). */
export declare const PLUGIN_NAME = "homebridge-mynest";
/** Platform identifier referenced in the user's Homebridge config. */
export declare const PLATFORM_NAME = "MyNest";
/** Prefix used when generating stable HAP accessory UUIDs. */
export declare const UUID_PREFIX = "mynest-";
/**
 * Synthetic device id for the optional house-wide Eco Mode switch.
 *
 * Not a Nest resource — used only for Homebridge cache / HomeKit UUID stability.
 */
export declare const GLOBAL_ECO_DEVICE_ID = "GLOBAL_ECO";
/** Reported as the HomeKit accessory manufacturer. */
export declare const MANUFACTURER = "Nest";
/**
 * Browser user agent sent on every request.
 *
 * These endpoints are the Nest web app's own backend and reject clients that
 * do not look like a browser.
 */
export declare const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/77.0.3865.120 Safari/537.36";
/**
 * Version string the Nest web app sends on Observe requests.
 *
 * The gateway uses it to decide which trait schema it will serve. Bumping it
 * blind risks receiving traits this plugin cannot decode, so it stays pinned
 * to a version confirmed working against a live account.
 */
export declare const WEB_APP_VERSION = "NlAppSDKVersion/8.15.0 NlSchemaVersion/2.1.20-87-gce5742894";
/** Every host and path the plugin talks to, for one Nest environment. */
export interface NestEndpoints {
    /** Hostname of the Nest REST API. */
    readonly apiHostname: string;
    /** `GET` here with the config token to open a session. */
    readonly sessionUrl: string;
    /** Origin of the HTTP/2 gRPC-web gateway that serves the Observe stream. */
    readonly grpcOrigin: string;
    /** Path on {@link grpcOrigin} that streams trait snapshots and patches. */
    readonly observePath: string;
    /** Path on {@link grpcOrigin} for thermostat (and other trait) writes. */
    readonly batchUpdatePath: string;
    /** Path appended to the session's `transport_url` for the REST long-poll. */
    readonly subscribePath: string;
}
/** Resolve the endpoint set for the configured environment. */
export declare function resolveEndpoints(isFieldTest: boolean): NestEndpoints;
/** Build the `app_launch` URL, which is scoped to one user id. */
export declare function appLaunchUrl(endpoints: NestEndpoints, userId: string): string;
/**
 * Bucket types requested from `app_launch`.
 *
 * Nest returns only the buckets the account actually has, so asking for a type
 * the home does not own is free. `device` and `shared` are requested even
 * though a protobuf-only account returns neither: an account with an older
 * thermostat does return them, and they are the cheaper read when present.
 */
export declare const APP_LAUNCH_BUCKET_TYPES: readonly string[];
/** Hard ceiling on opening a session. Never wait on Nest indefinitely. */
export declare const SESSION_TIMEOUT_MS = 40000;
/** Hard ceiling on an `app_launch`, which returns the whole account at once. */
export declare const APP_LAUNCH_TIMEOUT_MS = 120000;
/**
 * How long to hold a REST `subscribe` long-poll open before aborting it.
 *
 * Nest parks the request until something changes, so the client decides the
 * cycle length. Two minutes matches what Nest's own web app uses; aborting is
 * the normal outcome on a quiet home, not a failure.
 */
export declare const SUBSCRIBE_TIMEOUT_MS = 120000;
/**
 * How long after the last successful REST cycle (including idle subscribe)
 * Protect smoke/CO may still be treated as live from cached topaz.
 *
 * Must exceed {@link SUBSCRIBE_TIMEOUT_MS}: a quiet house parks the long-poll
 * for the full client timeout without being unhealthy. Beyond this window,
 * tiles stay in HomeKit but are marked inactive/faulted — never a live frozen
 * all-clear, and never torn down (rooms/automations keep their targets).
 */
export declare const REST_ALARM_FEED_STALE_MS: number;
/**
 * How long a single Observe connection is held before being recycled.
 *
 * Nest drops these streams on its own schedule, and a stream that has silently
 * stopped delivering is indistinguishable from a quiet home. Recycling on a
 * known cadence turns an unbounded stall into a bounded one.
 */
export declare const OBSERVE_SESSION_MS: number;
/** Interval between HTTP/2 pings that keep the Observe stream from idling out. */
export declare const OBSERVE_PING_INTERVAL_MS = 60000;
/**
 * Longest silence tolerated on an Observe stream before it is recycled.
 *
 * A live account emits at minimum a periodic trait refresh well inside this
 * window. Exceeding it means the socket is up but the stream is dead, which is
 * the failure mode that leaves HomeKit showing stale temperatures indefinitely.
 */
export declare const OBSERVE_IDLE_TIMEOUT_MS: number;
/** Delay before the first reconnect attempt after a transport drops. */
export declare const RECONNECT_BASE_MS = 5000;
/** Upper bound on the reconnect backoff. */
export declare const RECONNECT_MAX_MS: number;
/**
 * Floor on how fast the REST subscribe loop may cycle on a success path.
 *
 * Nest can answer a long-poll with an empty 200, or convert a 502/504 into an
 * idle result, in milliseconds. Without a floor every installed plugin becomes
 * an unthrottled request loop against a degraded edge. Failures already wait
 * via reconnect backoff; this bound covers the non-throwing path.
 */
export declare const MIN_SUBSCRIBE_CYCLE_MS = 2000;
/**
 * How long to wait after start before warning that Observe has produced no frames.
 *
 * Thermostats are Observe-only on modern accounts. Silence at info level here
 * leaves HomeKit empty while the log only says "Connected to Nest".
 */
export declare const OBSERVE_STARTUP_WARN_MS = 60000;
/**
 * Quiet period after the last Observe trait of a reconnect before treating the
 * opening burst as a complete device snapshot.
 *
 * Nest delivers the full inventory as many frames in quick succession, then
 * goes quiet until a real patch. Waiting slightly longer than the platform's
 * update coalesce window avoids pruning mid-burst when a late frame arrives.
 */
export declare const OBSERVE_SNAPSHOT_SETTLE_MS = 750;
/**
 * Consecutive HTTP 403 responses on one transport before that loop gives up.
 *
 * A single 403 on a Nest edge host can be a WAF / bot-detection blip against
 * the pinned user agent. Counters are per-transport so REST blips cannot kill
 * a healthy Observe stream (and vice versa). The plugin only treats the token
 * as dead when *both* loops have exhausted this budget. 401 always means the
 * token is rejected immediately.
 */
export declare const FORBIDDEN_FATAL_THRESHOLD = 3;
/**
 * How long a session is reused before it is re-established.
 *
 * Nest reports an `expires_in` far longer than this, but a token that has been
 * revoked server-side keeps working until first refusal. Re-opening on a fixed
 * cadence bounds how long the plugin can run on a dead session.
 */
export declare const SESSION_REFRESH_MS: number;
/** Maximum attempts for a single REST request before surfacing the failure. */
export declare const MAX_REQUEST_ATTEMPTS = 3;
/**
 * How often to re-run `app_launch` to pick up devices added or removed.
 *
 * The subscribe loop reports changes to buckets it already knows about, so it
 * cannot notice a brand-new device. Hourly keeps a rare event reasonably fresh
 * without spending requests on a list that almost never changes.
 */
export declare const REDISCOVERY_INTERVAL_MS: number;
/**
 * Shortest allowed diagnostics heartbeat when the feature is enabled (seconds).
 *
 * Sub-floor positive values are raised to this rather than rejected.
 */
export declare const MIN_DIAGNOSTICS_INTERVAL_SEC = 30;
/**
 * Cap on the diagnostics heartbeat interval, in seconds (one day).
 *
 * Bounded so an over-range `setInterval` delay cannot collapse to 1 ms in Node
 * (delays above 2^31-1 ms do), and so the config UI can offer a typed field
 * instead of a one-hour slider.
 */
export declare const MAX_DIAGNOSTICS_INTERVAL_SEC = 86400;
/**
 * Nest's own occupancy hold-off for a Protect, in seconds.
 *
 * A Protect does not report motion. It reports `auto_away`, which Nest flips
 * only after roughly ten minutes with no activity, and clears on the first
 * detection. HomeKit occupancy is therefore ten-minute-resolution presence,
 * not motion, and the README says so plainly. Exposed here so the value used
 * in log messages and documentation has a single source.
 */
export declare const PROTECT_OCCUPANCY_HOLD_OFF_SEC = 600;
/** Floor on the thermostat setpoint HomeKit may request, in Celsius. */
export declare const MIN_SETPOINT_C = 9;
/** Ceiling on the thermostat setpoint HomeKit may request, in Celsius. */
export declare const MAX_SETPOINT_C = 32;
/** Granularity of thermostat setpoints in Celsius, matching Nest's own UI. */
export declare const SETPOINT_STEP_C = 0.5;
//# sourceMappingURL=settings.d.ts.map