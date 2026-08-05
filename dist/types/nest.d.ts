/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shapes returned by the Nest REST API.
 *
 * Every field here was observed on a live account. Fields are optional and
 * loosely typed on purpose: Nest returns different subsets per firmware
 * revision, and a bucket missing a field must degrade to "unknown" rather than
 * throw.
 */
/** The session returned by `GET /session`, reduced to what the plugin uses. */
export interface NestSession {
    /** Bearer used as HTTP Basic auth on every subsequent call. */
    readonly token: string;
    readonly userId: string;
    /** Per-account host the REST subscribe long-poll must be sent to. */
    readonly transportUrl: string;
    /** When this session was opened, driving periodic refresh. */
    readonly openedAt: number;
    /**
     * When Nest says this session expires, from `expires_in`.
     *
     * Absent when Nest omits it. Nest usually reports a window far longer than
     * the plugin's own refresh cadence, but if it ever reports a shorter one the
     * server's answer must win — otherwise the plugin runs on a dead session
     * until the first refusal.
     */
    readonly expiresAt?: number;
}
/**
 * One versioned object from `app_launch` or `subscribe`.
 *
 * `object_key` is `"{bucket_type}.{id}"`. The revision and timestamp are echoed
 * back on the next subscribe so Nest knows what the client has already seen;
 * getting them wrong makes the long-poll return immediately in a hot loop.
 */
export interface NestObject {
    object_key: string;
    object_revision?: number;
    object_timestamp?: number;
    value?: unknown;
}
/** Response shape shared by `app_launch` and `subscribe`. */
export interface NestObjectResponse {
    updated_buckets?: NestObject[];
    objects?: NestObject[];
}
/** `subscribe` outcome, including the ordinary "nothing changed" case. */
export interface SubscribeResult {
    /** True when the long-poll was aborted by the client with no updates. */
    readonly isIdle: boolean;
    readonly objects: readonly NestObject[];
    /**
     * Whether Nest actually answered, as opposed to the client deadline firing
     * with nothing received.
     *
     * A quiet house and a blackholed route both produce a full-length timeout, so
     * elapsed time cannot tell them apart — only the presence of a response can.
     * Without this the transport counted "no bytes from Nest for two minutes" as a
     * successful cycle, which refreshed the Protect alarm-feed freshness clock and
     * reset the circuit breaker, leaving smoke/CO tiles showing a live frozen
     * all-clear while diagnostics reported healthy.
     */
    readonly hadResponse: boolean;
}
/** Buckets indexed as `{ bucketType: { id: value } }`. */
export type BucketMap = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
/**
 * `structure.{id}` — one home.
 *
 * Requested in `APP_LAUNCH_BUCKET_TYPES` (`settings.ts`) and recorded here as the shape
 * Nest returns, but nothing reads it yet: room names come from `where` and the
 * device list from the Observe ∪ REST union. `num_thermostats` in particular is
 * deliberately not trusted — the account this plugin was built against reported
 * `"5+"` while returning no thermostat buckets at all.
 */
export interface StructureBucket {
    name?: string;
    country_code?: string;
    away?: boolean;
    /** `"{bucket_type}.{id}"` references to every device in the home. */
    swarm?: string[];
    rcs_sensor_swarm?: string[];
    num_thermostats?: unknown;
}
/** `topaz.{serial}` — one Nest Protect. */
export interface TopazBucket {
    serial_number?: string;
    structure_id?: string;
    where_id?: string;
    description?: string;
    model?: string;
    /** `0` is clear; anything else is an alarm. */
    smoke_status?: number;
    co_status?: number;
    /** `0` is OK; anything else means replace the battery. */
    battery_health_state?: number;
    /** Millivolts, despite the name — a healthy Protect reads about 5226. */
    battery_level?: number;
    /** Wired Protects report `true`; battery-only models do not report occupancy. */
    line_power_present?: boolean;
    /**
     * Nest's own occupancy verdict, inverted: `true` means nobody has been seen.
     *
     * Not motion. Nest sets this only after roughly ten minutes without a
     * detection — see `PROTECT_OCCUPANCY_HOLD_OFF_SEC` in `settings.ts`, which
     * this file deliberately does not import so it stays free of dependencies.
     */
    auto_away?: boolean;
    /** Length of the no-activity window, in seconds — not a timestamp. */
    auto_away_decision_time_secs?: number;
    /** Nest's own liveness flag for the device. */
    component_wifi_test_passed?: boolean;
    wifi_ip_address?: string;
    /** True when this device's authoritative state lives on the Observe stream. */
    using_protobuf?: boolean;
    /** Celsius. Present on Protects with a temperature sensor. */
    current_temperature?: number;
    /**
     * Structure home/away hint when present on some firmware revisions.
     *
     * Typed as unknown because Nest has returned both boolean and numeric forms
     * in the wild; nothing in this plugin reads the field.
     */
    home_away_input?: unknown;
}
/** `kryptonite.{serial}` — one Nest Temperature Sensor. */
export interface KryptoniteBucket {
    serial_number?: string;
    structure_id?: string;
    where_id?: string;
    description?: string;
    /** Celsius. */
    current_temperature?: number;
    /** Percent. */
    battery_level?: number;
    last_updated_at?: number;
}
/** `device.{serial}` — thermostat hardware state, on non-protobuf accounts. */
export interface DeviceBucket {
    serial_number?: string;
    structure_id?: string;
    where_id?: string;
    name?: string;
    model_version?: string;
    current_humidity?: number;
    backplate_temperature?: number;
    has_leaf?: boolean;
    using_protobuf?: boolean;
}
/** `shared.{serial}` — thermostat setpoints, on non-protobuf accounts. */
export interface SharedBucket {
    name?: string;
    /** `off` | `heat` | `cool` | `range`. */
    target_temperature_type?: string;
    target_temperature?: number;
    target_temperature_low?: number;
    target_temperature_high?: number;
    current_temperature?: number;
    hvac_heater_state?: boolean;
    hvac_ac_state?: boolean;
    can_heat?: boolean;
    can_cool?: boolean;
}
/** `where.{structureId}` — the room names devices are assigned to. */
export interface WhereBucket {
    wheres?: Array<{
        where_id?: string;
        name?: string;
    }>;
}
