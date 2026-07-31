/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest's REST bucket API: `app_launch` and the subscribe long-poll.
 *
 * `app_launch` returns every bucket the account owns in one response and seeds
 * the object list. `subscribe` then holds a connection open until one of those
 * objects changes, echoing back the revision and timestamp of everything the
 * client has already seen.
 *
 * On accounts whose thermostats have moved to the protobuf backend, this API
 * reports the Protects and temperature sensors but no thermostats at all — see
 * `docs/PROTOCOL.md`. It is a source of truth for what it does report, not for
 * what the home contains.
 */
import { type NestEndpoints } from '../settings';
import type { BucketMap, NestObject, NestSession, SubscribeResult } from '../types/nest';
import { type FetchLike } from './http';
export interface RestRequestOptions {
    session: NestSession;
    endpoints: NestEndpoints;
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
}
/**
 * Pull every bucket the account owns.
 *
 * @param bucketTypes The bucket types to ask for. Requesting a type the home
 *   does not own is free; Nest simply omits it from the response.
 */
export declare function appLaunch(options: RestRequestOptions & {
    bucketTypes: readonly string[];
}): Promise<NestObject[]>;
/**
 * Wait for any known object to change.
 *
 * Nest parks this request until something happens, so the client decides how
 * long a cycle lasts. Reaching that deadline with nothing to report is the
 * ordinary outcome on a quiet home, which is why it returns
 * `{ isIdle: true }` rather than throwing: treating it as an error would fill
 * the log with failures on a house where nobody is home.
 *
 * A caller-supplied `signal` (shutdown) still propagates as an abort, so the
 * two cases stay distinguishable.
 */
export declare function subscribeOnce(options: RestRequestOptions & {
    objects: readonly NestObject[];
    timeoutMs?: number;
}): Promise<SubscribeResult>;
/**
 * An object list that tracks the revision of every bucket seen so far.
 *
 * The revisions are what make the long-poll work: Nest compares them against
 * its own and returns immediately if the client is behind. Failing to merge
 * updates back in turns the long-poll into a busy loop.
 */
/** Result of applying a full `app_launch` enumeration to {@link ObjectList}. */
export interface AppLaunchSnapshotResult {
    /** Object keys dropped after a second consecutive omission. */
    readonly dropped: readonly string[];
    /** True when the payload looked truncated and nothing was dropped. */
    readonly truncated: boolean;
    /** Object count before this snapshot was applied. */
    readonly previousCount: number;
}
export declare class ObjectList {
    #private;
    /** Apply an update, replacing any previous revision of the same object. */
    merge(updates: readonly NestObject[]): void;
    /**
     * Apply a full `app_launch` enumeration with outage guards.
     *
     * - Empty or half-size payloads are treated as truncated: present keys are
     *   merged, missing keys are kept (a Nest blip must not wipe the house).
     * - Missing keys on a complete-looking payload get a two-strike removal so
     *   one thin-but-not-half response cannot unregister accessories.
     */
    applyAppLaunchSnapshot(updates: readonly NestObject[]): AppLaunchSnapshotResult;
    /**
     * Replace the list wholesale without outage guards.
     *
     * Prefer {@link applyAppLaunchSnapshot} for live Nest reads. Kept for tests
     * that need an immediate reset of the bucket map.
     */
    replace(updates: readonly NestObject[]): void;
    get objects(): readonly NestObject[];
    get size(): number;
    /**
     * Index the objects as `{ bucketType: { id: value } }`.
     *
     * The split is on the *first* dot only: Protect serial numbers contain none,
     * but structure and where ids do, and splitting on every dot silently drops
     * those buckets.
     */
    toBuckets(): BucketMap;
}
//# sourceMappingURL=rest.d.ts.map