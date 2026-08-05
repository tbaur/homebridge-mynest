/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Plugin-wide constants and Nest endpoints.
 *
 * Nest publishes no consumer API for these paths and no documentation. Every
 * value here was confirmed empirically against a live account with a
 * maintainer-only probe kit that is not part of this repository, and each one
 * that looks arbitrary carries a comment explaining why it is what it is.
 * Treat this file as the record of what the service actually does, because
 * nothing external will tell you when it changes.
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
/**
 * HomeKit name of the house-wide Eco Mode switch.
 *
 * Declared here because the platform and the accessory both publish it, and a
 * mismatch would rename the tile on every restart.
 */
export declare const GLOBAL_ECO_DISPLAY_NAME = "Nest Eco Mode";
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
 * Hard ceiling on a BatchUpdateState write.
 *
 * A HomeKit-originated write is user-facing: the Home app spinner sits there
 * until this resolves, so the deadline is far shorter than a read's.
 */
export declare const BATCH_UPDATE_TIMEOUT_MS = 30000;
/**
 * How long to hold a REST `subscribe` long-poll open before aborting it.
 *
 * Nest parks the request until something changes, so the client decides the
 * cycle length. Two minutes matches what Nest's own web app uses; aborting is
 * the normal outcome on a quiet home, not a failure.
 */
export declare const SUBSCRIBE_TIMEOUT_MS = 120000;
/**
 * Fraction of the subscribe budget a 502/504 must have consumed to count as an
 * expired long-poll rather than a failing edge.
 *
 * Nest answers a long-poll that timed out server-side with 502 or 504, which is
 * an ordinary idle result. A broken edge returns the same codes in
 * milliseconds. Treating the fast case as idle marks the REST cycle successful,
 * which both refreshes the Protect alarm-feed staleness clock — leaving a
 * frozen all-clear on a life-safety tile — and clears the backoff, turning the
 * loop into a 2-second poll against an already-degraded service. Elapsed time
 * is the only signal that separates them.
 */
export declare const SUBSCRIBE_IDLE_MIN_ELAPSED_RATIO = 0.5;
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
 * How long REST may go without Nest actually answering before the plugin
 * proves reachability with an `app_launch`.
 *
 * The subscribe long-poll can time out client-side with no response on a
 * genuinely quiet house, so silence alone is not a fault — but it is also not
 * evidence of health. This bounds how long the plugin can be blind to a
 * blackholed route, at the cost of one extra full read per window on an account
 * that really is silent.
 */
export declare const REST_PROOF_OF_LIFE_MS: number;
/**
 * How long after Nest's last actual response the alarm feed stops counting as
 * live, regardless of timed-out cycles.
 *
 * Sits above {@link REST_PROOF_OF_LIFE_MS} so a successful proof-of-life read
 * always lands first on a healthy account; only a genuine outage reaches it.
 */
export declare const REST_RESPONSE_STALE_MS: number;
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
 * How long a connection must last to count as productive rather than a flap.
 *
 * Nest sends a resource catalogue as the first frame of every connection, so
 * frame count alone cannot distinguish a working stream from a gateway that
 * accepts and immediately drops. Without a duration floor the latter resets
 * the reconnect backoff on every attempt.
 */
export declare const OBSERVE_PRODUCTIVE_SESSION_MS = 30000;
/**
 * Deadline for the Observe gateway to answer with response headers.
 *
 * The idle deadline is ten minutes, which is the right bound for a *connected*
 * stream that goes quiet but far too long for one that never connects — and
 * Observe is the only source of thermostat state.
 */
export declare const OBSERVE_CONNECT_TIMEOUT_MS = 30000;
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
 * How long a fresh Observe session may go without naming a single device before
 * the snapshot collector gives up on it.
 *
 * Distinct from {@link OBSERVE_SNAPSHOT_SETTLE_MS}, which is a quiet period
 * *after* traits have started arriving. This one has to absorb TCP, TLS, and
 * gateway processing on a residential link, so it is an order of magnitude
 * longer — using the short quiet period for both meant a merely slow connection
 * finalized an empty snapshot and silently disabled HomeKit pruning.
 */
export declare const OBSERVE_SNAPSHOT_ABANDON_MS = 30000;
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
 * How long a 403-exhausted transport waits before probing again.
 *
 * The 403 budget is spent in roughly fifteen seconds, so without a re-probe a
 * transient WAF block permanently disabled a transport for the life of the
 * process — freezing every thermostat if Observe was the casualty, or faulting
 * every Protect if REST was. Long enough that re-probing cannot itself sustain
 * the block.
 */
export declare const FORBIDDEN_REPROBE_MS: number;
/**
 * How long a session is reused before it is re-established.
 *
 * Nest reports an `expires_in` far longer than this, but a token that has been
 * revoked server-side keeps working until first refusal. Re-opening on a fixed
 * cadence bounds how long the plugin can run on a dead session.
 */
export declare const SESSION_REFRESH_MS: number;
/**
 * Refresh a session this long before Nest's own reported expiry.
 *
 * Only used when `GET /session` reports `expires_in`; otherwise
 * {@link SESSION_REFRESH_MS} is the only trigger.
 */
export declare const SESSION_EXPIRY_MARGIN_MS: number;
/** Maximum attempts for a single REST request before surfacing the failure. */
export declare const MAX_REQUEST_ATTEMPTS = 3;
/**
 * Attempts for a HomeKit-driven thermostat write.
 *
 * Lower than a read's: a user is watching the Home app spinner. One retry
 * covers a dropped packet without making a failure feel like a hang.
 */
export declare const BATCH_UPDATE_MAX_ATTEMPTS = 2;
/**
 * Warn on the first transport failure and every Nth after it.
 *
 * Everything in between stays at debug: a flapping connection must be visible
 * without flooding the log of an otherwise healthy install.
 */
export declare const LOOP_FAILURE_WARN_EVERY = 10;
/** Interval between operator-visible transport status lines. */
export declare const STATUS_HEARTBEAT_MS: number;
/**
 * Recent Observe frames considered when judging whether decoding is working.
 *
 * Wide enough that the per-connection catalogue frame (which never decodes as a
 * `StreamBody`) cannot on its own push the failure ratio over the threshold.
 */
export declare const FRAME_DECODE_WINDOW = 20;
/** Undecodable share of the recent window that warrants warning the operator. */
export declare const FRAME_DECODE_FAILURE_RATIO = 0.5;
/** How often to check whether the Observe stream has gone silent. */
export declare const OBSERVE_SILENCE_CHECK_MS: number;
/**
 * Longest ceiling honoured from a server `Retry-After`.
 *
 * The header is untrusted. A delay above 2^31-1 ms collapses to 1 ms in Node's
 * `setTimeout`, so an absurd value would turn a rate-limit response into an
 * immediate retry — the opposite of what it asks for.
 */
export declare const MAX_RETRY_AFTER_MS: number;
/**
 * Shortest delay honoured from a server `Retry-After`.
 *
 * A server may legitimately send `Retry-After: 0`, but consumers select its
 * value with `??` — which does not treat `0` as absent — so a zero would
 * bypass computed backoff entirely and spin.
 */
export declare const MIN_RETRY_AFTER_MS = 1000;
/**
 * Largest REST response body accepted, in bytes.
 *
 * `app_launch` returns the whole account, so this is generous — but without a
 * ceiling a malfunctioning or hostile endpoint can exhaust memory and take down
 * every plugin sharing the Homebridge process. Mirrors the frame ceiling the
 * Observe path already enforces.
 */
export declare const MAX_RESPONSE_BYTES: number;
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
/**
 * Setpoint assumed when Nest has reported none at all.
 *
 * Only reachable on a write against a thermostat whose setpoint traits have
 * not arrived, which HomeKit can provoke immediately after a restart.
 */
export declare const DEFAULT_SETPOINT_C = 20;
/**
 * Gap opened between heat and cool when Nest reported only one of the pair.
 *
 * Nest's trait always carries both bounds, so a write has to supply a value
 * for the bound the user did not touch.
 */
export declare const DEFAULT_SETPOINT_SPAN_C = 5;
/**
 * Smallest gap Nest will hold between the heat and cool setpoints.
 *
 * A write that would cross the bounds is widened to this rather than being
 * rejected, so HomeKit never has a change silently dropped.
 */
export declare const MIN_SETPOINT_SPAN_C = 2;
/** Coldest reading treated as real rather than a decode landing on a wrong field. */
export declare const MIN_REPORTED_TEMPERATURE_C = -50;
/** Hottest reading treated as real. Matches HomeKit's own ceiling. */
export declare const MAX_REPORTED_TEMPERATURE_C = 100;
/**
 * Granularity HomeKit is told to expect for a temperature *reading*.
 *
 * Matches HAP's own default. Reusing the coarser {@link SETPOINT_STEP_C} here
 * would round every reading to the nearest half degree, so the same physical
 * sensor would disagree with itself between a thermostat tile and its own.
 */
export declare const REPORTED_TEMPERATURE_STEP_C = 0.1;
//# sourceMappingURL=settings.d.ts.map