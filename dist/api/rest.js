"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObjectList = void 0;
exports.appLaunch = appLaunch;
exports.subscribeOnce = subscribeOnce;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
const session_1 = require("./session");
const http_1 = require("./http");
/**
 * Pull every bucket the account owns.
 *
 * @param bucketTypes The bucket types to ask for. Requesting a type the home
 *   does not own is free; Nest simply omits it from the response.
 */
async function appLaunch(options) {
    const body = await (0, http_1.requestJson)((0, settings_1.appLaunchUrl)(options.endpoints, options.session.userId), {
        method: 'POST',
        headers: (0, session_1.authenticatedHeaders)(options.session),
        body: JSON.stringify({
            known_bucket_types: options.bucketTypes,
            known_bucket_versions: [],
        }),
        timeoutMs: settings_1.APP_LAUNCH_TIMEOUT_MS,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
    });
    return readObjects(body);
}
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
async function subscribeOnce(options) {
    const timeoutMs = options.timeoutMs ?? settings_1.SUBSCRIBE_TIMEOUT_MS;
    const url = `${options.session.transportUrl}${options.endpoints.subscribePath}`;
    // Only the identifiers are echoed back, never the values. Sending the whole
    // bucket contents makes the request enormous on a home with many devices and
    // changes nothing about what Nest returns.
    //
    // Still stripped explicitly even though `ObjectRevision` declares only these
    // three fields: TypeScript's structural typing lets a richer object through,
    // and the request-size guarantee is worth more than one array allocation per
    // two-minute cycle. What {@link ObjectList.revisions} removed was the *second*
    // copy — it no longer materialises every whole bucket first.
    const payload = {
        objects: options.revisions.map(({ object_key, object_revision, object_timestamp }) => ({
            object_key,
            object_revision,
            object_timestamp,
        })),
    };
    const startedAt = Date.now();
    let response;
    try {
        response = await (0, http_1.sendRequest)(url, {
            method: 'POST',
            headers: (0, session_1.authenticatedHeaders)(options.session),
            body: JSON.stringify(payload),
            timeoutMs,
            fetchImpl: options.fetchImpl,
            signal: options.signal,
        });
    }
    catch (error) {
        // A client-side deadline with no response is the idle case. sendRequest
        // has already re-thrown a caller abort untouched, so reaching here with a
        // TimeoutError means Nest simply had nothing to say.
        if (isIdleTimeout(error, options.signal)) {
            // No response at all — report that, so the caller does not treat silence
            // as evidence that Nest is reachable.
            return { isIdle: true, objects: [], hadResponse: false };
        }
        throw error;
    }
    // Nest answers a long-poll that expires server-side with 502 or 504 rather
    // than an empty 200. That is the same "nothing happened" outcome and must
    // not be retried as a failure — but only when the request actually waited.
    // A 502 that comes back immediately is a failing edge, and reporting it as a
    // successful idle cycle keeps Protect smoke/CO looking live while removing
    // the backoff that would otherwise throttle the retry.
    if (response.status === 502 || response.status === 504) {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= timeoutMs * settings_1.SUBSCRIBE_IDLE_MIN_ELAPSED_RATIO) {
            return { isIdle: true, objects: [], hadResponse: true };
        }
        throw (0, errors_1.createApiError)(response.status, `subscribe returned HTTP ${response.status} after ${elapsedMs}ms, too fast to be an expired long-poll`, { retryAfterMs: (0, errors_1.parseRetryAfterMs)(response.headers.get('retry-after')) });
    }
    if (response.status >= 400) {
        throw (0, errors_1.createApiError)(response.status, `subscribe returned HTTP ${response.status}`, {
            retryAfterMs: (0, errors_1.parseRetryAfterMs)(response.headers.get('retry-after')),
        });
    }
    let body;
    try {
        body = JSON.parse(response.text);
    }
    catch (error) {
        throw new errors_1.ApiParseError('subscribe returned a body that is not JSON', {
            cause: error instanceof Error ? error : undefined,
        });
    }
    const objects = readObjects(body);
    return { isIdle: objects.length === 0, objects, hadResponse: true };
}
function isIdleTimeout(error, signal) {
    if (signal?.aborted) {
        return false;
    }
    return error instanceof Error && error.name === 'TimeoutError';
}
/**
 * Property names that must never be used as a bucket type or id.
 *
 * `object_key` is server-controlled and is split into two object keys by
 * {@link ObjectList.toBuckets}. Without this guard a response naming
 * `__proto__.x` writes onto `Object.prototype` — corrupting every object in
 * the Homebridge process, not just this plugin — and `constructor.prototype`
 * throws a `TypeError` that recurs on every cycle because the poisoned entry
 * is already stored.
 */
const UNSAFE_KEY_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
/** Whether an `object_key` is safe to use as `{ type: { id: value } }` keys. */
function isSafeObjectKey(objectKey) {
    const separator = objectKey.indexOf('.');
    if (separator <= 0 || separator === objectKey.length - 1) {
        // Unsplittable keys are dropped later by `toBuckets`; accept them here so
        // revision tracking for the long-poll stays complete.
        return !UNSAFE_KEY_SEGMENTS.has(objectKey);
    }
    return !UNSAFE_KEY_SEGMENTS.has(objectKey.slice(0, separator))
        && !UNSAFE_KEY_SEGMENTS.has(objectKey.slice(separator + 1));
}
/**
 * Read the object list out of a response.
 *
 * Nest uses `updated_buckets` on some responses and `objects` on others for
 * the same payload, so both are accepted. An empty `updated_buckets` falls
 * through to `objects`: `??` would stop at the empty array and report a
 * response that did carry updates as idle, discarding them.
 */
function readObjects(body) {
    const raw = body.updated_buckets?.length ? body.updated_buckets : (body.objects ?? []);
    return Array.isArray(raw)
        ? raw.filter((entry) => Boolean(entry)
            && typeof entry === 'object'
            && typeof entry.object_key === 'string'
            && isSafeObjectKey(entry.object_key))
        : [];
}
class ObjectList {
    #byKey = new Map();
    /**
     * Keys missing from the previous complete `app_launch`. A key is deleted
     * only after a second consecutive complete snapshot omits it.
     */
    #removalCandidates = new Set();
    /** Apply an update, replacing any previous revision of the same object. */
    merge(updates) {
        for (const update of updates) {
            if (!update?.object_key) {
                continue;
            }
            this.#byKey.set(update.object_key, { ...update });
        }
    }
    /**
     * Apply a full `app_launch` enumeration with outage guards.
     *
     * - Empty or half-size payloads are treated as truncated: present keys are
     *   merged, missing keys are kept (a Nest blip must not wipe the house).
     * - Missing keys on a complete-looking payload get a two-strike removal so
     *   one thin-but-not-half response cannot unregister accessories.
     */
    applyAppLaunchSnapshot(updates) {
        const incoming = new Map();
        for (const update of updates) {
            if (!update?.object_key) {
                continue;
            }
            incoming.set(update.object_key, { ...update });
        }
        const previousCount = this.#byKey.size;
        if (previousCount > 0 && incoming.size * 2 < previousCount) {
            this.merge([...incoming.values()]);
            for (const key of incoming.keys()) {
                this.#removalCandidates.delete(key);
            }
            return { dropped: [], truncated: true, previousCount };
        }
        this.merge([...incoming.values()]);
        for (const key of incoming.keys()) {
            this.#removalCandidates.delete(key);
        }
        const missing = [...this.#byKey.keys()].filter((key) => !incoming.has(key));
        const dropped = [];
        for (const key of missing) {
            if (this.#removalCandidates.has(key)) {
                this.#byKey.delete(key);
                this.#removalCandidates.delete(key);
                dropped.push(key);
            }
            else {
                this.#removalCandidates.add(key);
            }
        }
        return { dropped, truncated: false, previousCount };
    }
    /**
     * Replace the list wholesale without outage guards.
     *
     * @internal Tests only. Live Nest reads must go through
     *   {@link applyAppLaunchSnapshot}, whose truncation and two-strike guards
     *   are what stop a Nest blip from unregistering every accessory.
     */
    replace(updates) {
        this.#byKey.clear();
        this.#removalCandidates.clear();
        this.merge(updates);
    }
    /** @internal Tests only; the subscribe loop uses {@link revisions}. */
    get objects() {
        return [...this.#byKey.values()];
    }
    /**
     * The identifiers the subscribe long-poll needs, built in one pass.
     *
     * Getting this from `objects` copied every tracked bucket and then mapped it
     * again — two full allocations of the whole bucket map per cycle.
     */
    get revisions() {
        const revisions = [];
        for (const { object_key, object_revision, object_timestamp } of this.#byKey.values()) {
            revisions.push({ object_key, object_revision, object_timestamp });
        }
        return revisions;
    }
    get size() {
        return this.#byKey.size;
    }
    /**
     * Index the objects as `{ bucketType: { id: value } }`.
     *
     * The split is on the *first* dot only: Protect serial numbers contain none,
     * but structure and where ids do, and splitting on every dot silently drops
     * those buckets.
     */
    toBuckets() {
        // Null-prototype maps: these keys come from Nest, and a plain object would
        // resolve `__proto__` to `Object.prototype` (so `??=` skips assignment and
        // the write lands on the prototype) or `constructor` to a frozen function.
        // `readObjects` already rejects those keys; this is the second layer, so a
        // future caller that bypasses the boundary cannot reintroduce the hole.
        const buckets = Object.create(null);
        for (const object of this.#byKey.values()) {
            const separator = object.object_key.indexOf('.');
            if (separator <= 0 || separator === object.object_key.length - 1) {
                continue;
            }
            const type = object.object_key.slice(0, separator);
            const id = object.object_key.slice(separator + 1);
            if (UNSAFE_KEY_SEGMENTS.has(type) || UNSAFE_KEY_SEGMENTS.has(id)) {
                continue;
            }
            buckets[type] ??= Object.create(null);
            buckets[type][id] = object.value ?? null;
        }
        return buckets;
    }
}
exports.ObjectList = ObjectList;
//# sourceMappingURL=rest.js.map