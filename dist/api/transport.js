"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Runs both Nest transports for the lifetime of the plugin.
 *
 * The two loops are deliberately independent. Observe carries thermostats and
 * is the only place several devices appear at all; REST carries Protect alarm
 * state and battery levels. Either can fail without the other, and a home
 * where one is broken should keep updating through the one that works rather
 * than going dark.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NestTransport = void 0;
const settings_1 = require("../settings");
const errors_1 = require("../errors");
const protobuf_1 = require("./protobuf");
const rest_1 = require("./rest");
const session_1 = require("./session");
const observe_1 = require("./observe");
const batch_update_1 = require("./batch-update");
const thermostat_write_1 = require("./thermostat-write");
const circuit_breaker_1 = require("./circuit-breaker");
const retry_1 = require("../utils/retry");
const sanitizers_1 = require("../utils/sanitizers");
/** Owns the Nest session and both read loops. */
class NestTransport {
    #options;
    #objects = new rest_1.ObjectList();
    #abort = new AbortController();
    #restBreaker;
    #observeBreaker;
    #session = null;
    /** In-flight session open, shared so concurrent callers cannot stampede. */
    #sessionRefresh = null;
    #isStopped = false;
    /** Consecutive failures per transport, for log escalation. */
    #observeFailureStreak = 0;
    #restFailureStreak = 0;
    /** Most recent failure per transport, so a breaker trip can name its cause. */
    #lastObserveError = null;
    #lastRestError = null;
    /** Rolling window of frame decode outcomes; `true` means undecodable. */
    #recentFrameOutcomes = [];
    #didWarnDecodeRate = false;
    #observeFrames = 0;
    #restCycles = 0;
    #lastAppLaunchAt = 0;
    /** Consecutive HTTP 403s on the Observe loop only. */
    #observeForbidden = 0;
    /** Consecutive HTTP 403s on the REST subscribe loop only. */
    #restForbidden = 0;
    /** Observe gave up after repeated 403s; REST may still be alive. */
    #observeForbiddenDead = false;
    /** REST gave up after repeated 403s; Observe may still be alive. */
    #restForbiddenDead = false;
    #didWarnObserveSilent = false;
    #statusTimer = null;
    #observeSilenceTimer = null;
    #observeStartupWarnTimer = null;
    #lastObserveFrameAt = null;
    #observeSessionOpen = false;
    #restLoopRunning = false;
    #lastRestSuccessAt = null;
    #wasRestAlarmFeedAvailable = true;
    #restAlarmFeedStaleTimer = null;
    constructor(options) {
        this.#options = options;
        this.#restBreaker = options.restCircuitBreaker ?? new circuit_breaker_1.CircuitBreaker();
        this.#observeBreaker = options.observeCircuitBreaker ?? new circuit_breaker_1.CircuitBreaker();
        this.#wireBreaker(this.#restBreaker, 'rest');
        this.#wireBreaker(this.#observeBreaker, 'observe');
    }
    /** Attach logging + trip callback for one transport breaker. */
    #wireBreaker(breaker, transport) {
        const label = transport === 'rest' ? 'REST' : 'Observe';
        breaker.attachOnStateChange((from, to) => {
            const message = `Circuit breaker (${label}) ${from} -> ${to}`;
            if (to === circuit_breaker_1.CircuitState.OPEN) {
                // The trip is often the first default-visible sign of trouble, so it
                // has to name what actually broke and how long the cooldown is —
                // otherwise the operator learns only that "something failed five times".
                const last = transport === 'observe' ? this.#lastObserveError : this.#lastRestError;
                const cause = last ? ` (last: ${last})` : '';
                const cooldown = breaker.getStatus().remainingResetTimeMs;
                const retry = cooldown !== null ? `; retrying in ${Math.round(cooldown / 1000)}s` : '';
                this.#options.log.warn(`${message}${cause}${retry}`);
            }
            else {
                this.#options.log.info(message);
            }
            if (to === circuit_breaker_1.CircuitState.OPEN && from !== circuit_breaker_1.CircuitState.OPEN) {
                this.#options.onCircuitOpen?.(transport);
            }
            if (transport === 'rest') {
                this.#emitRestAlarmFeedAvailability();
            }
        });
    }
    get status() {
        const lastObserveFrameAgeSec = this.#lastObserveFrameAt === null
            ? null
            : Math.round((Date.now() - this.#lastObserveFrameAt) / 1000);
        const lastRestSuccessAgeSec = this.#lastRestSuccessAt === null
            ? null
            : Math.round((Date.now() - this.#lastRestSuccessAt) / 1000);
        return {
            hasSession: this.#session !== null,
            observeFrames: this.#observeFrames,
            restCycles: this.#restCycles,
            knownObjects: this.#objects.size,
            observeState: this.#observeState(),
            restState: this.#restState(),
            lastObserveFrameAgeSec,
            lastRestSuccessAgeSec,
            isRestAlarmFeedAvailable: this.#computeRestAlarmFeedAvailable(),
            circuitBreaker: {
                rest: this.#restBreaker.getStatus(),
                observe: this.#observeBreaker.getStatus(),
            },
        };
    }
    /** Whether cached REST topaz may still be treated as a live Protect alarm feed. */
    #computeRestAlarmFeedAvailable() {
        if (this.#isStopped || this.#restForbiddenDead) {
            return false;
        }
        // Subscribe loop exited after running (not mid-startup before the flag is set).
        if (!this.#restLoopRunning && this.#restCycles > 0) {
            return false;
        }
        if (this.#restBreaker.state !== circuit_breaker_1.CircuitState.CLOSED) {
            return false;
        }
        if (this.#lastRestSuccessAt === null) {
            return false;
        }
        return Date.now() - this.#lastRestSuccessAt <= settings_1.REST_ALARM_FEED_STALE_MS;
    }
    #noteRestSuccess() {
        this.#lastRestSuccessAt = Date.now();
        this.#armRestAlarmFeedStaleTimer();
        this.#emitRestAlarmFeedAvailability();
    }
    /**
     * Fire {@link #emitRestAlarmFeedAvailability} when the age-based stale window
     * elapses even if the subscribe loop is sleeping through a long backoff.
     */
    #armRestAlarmFeedStaleTimer() {
        if (this.#restAlarmFeedStaleTimer) {
            clearTimeout(this.#restAlarmFeedStaleTimer);
            this.#restAlarmFeedStaleTimer = null;
        }
        if (this.#lastRestSuccessAt === null) {
            return;
        }
        // Feed stays available while age <= STALE (`<=` in #computeRestAlarmFeedAvailable).
        // Fire on the first millisecond past that window so the emit is not a no-op.
        const remainingMs = settings_1.REST_ALARM_FEED_STALE_MS - (Date.now() - this.#lastRestSuccessAt) + 1;
        if (remainingMs <= 0) {
            this.#emitRestAlarmFeedAvailability();
            return;
        }
        this.#restAlarmFeedStaleTimer = setTimeout(() => {
            this.#restAlarmFeedStaleTimer = null;
            this.#emitRestAlarmFeedAvailability();
        }, remainingMs);
        this.#restAlarmFeedStaleTimer.unref?.();
    }
    #clearRestAlarmFeedStaleTimer() {
        if (this.#restAlarmFeedStaleTimer) {
            clearTimeout(this.#restAlarmFeedStaleTimer);
            this.#restAlarmFeedStaleTimer = null;
        }
    }
    #emitRestAlarmFeedAvailability() {
        const available = this.#computeRestAlarmFeedAvailable();
        if (available === this.#wasRestAlarmFeedAvailable) {
            return;
        }
        this.#wasRestAlarmFeedAvailable = available;
        // A return to normal is not a warning — operators page on those.
        if (available) {
            this.#options.log.info('REST alarm feed restored — Protect Smoke/CO live again.');
        }
        else {
            this.#options.log.warn('REST alarm feed unavailable — Protect Smoke/CO kept, marked inactive.');
        }
        this.#options.onRestAlarmFeedChange?.(available);
    }
    #observeState() {
        if (this.#observeForbiddenDead) {
            return 'forbidden_dead';
        }
        if (this.#isStopped) {
            return 'stopped';
        }
        if (this.#observeSessionOpen && this.#observeFrames > 0) {
            return 'connected';
        }
        return 'connecting';
    }
    #restState() {
        if (this.#restForbiddenDead) {
            return 'forbidden_dead';
        }
        if (this.#isStopped || !this.#restLoopRunning) {
            return 'stopped';
        }
        return 'running';
    }
    /**
     * Authenticate and take the first full read of the account.
     *
     * Resolves once REST has been enumerated, which is enough to publish
     * accessories; the Observe snapshot follows within a second or two and is
     * pushed as an update rather than being waited for. Blocking on it would
     * delay every REST-visible device behind the slower transport.
     *
     * @throws {AuthenticationError} When the token is rejected. Nothing can
     *   proceed without a session, so this is surfaced rather than retried.
     */
    async start() {
        this.#session = await this.#openSession();
        await this.#runAppLaunch();
        // Both loops run for the life of the plugin and are never awaited. Their
        // bodies are guarded, but their catch handlers are not, so an unhandled
        // rejection here would terminate the whole Homebridge process under Node's
        // default `--unhandled-rejections=throw` — taking every other plugin down.
        this.#runObserveLoop().catch((error) => {
            this.#options.log.error(`Observe loop stopped unexpectedly: ${(0, sanitizers_1.sanitizeError)(error)}`);
        });
        this.#runSubscribeLoop().catch((error) => {
            this.#restLoopRunning = false;
            this.#options.log.error(`REST loop stopped unexpectedly: ${(0, sanitizers_1.sanitizeError)(error)}`);
        });
        if (this.#options.statusHeartbeatEnabled !== false) {
            this.#startStatusHeartbeat();
        }
        this.#scheduleObserveStartupWarn();
        this.#startObserveSilenceWatch();
    }
    /**
     * Push a thermostat mode/setpoint change through BatchUpdateState.
     *
     * Observe-only thermostats have no REST `/v5/put` path; this is the write
     * Nest's own web app uses. Callers should already have gated on
     * `allowThermostatControl`.
     */
    async updateThermostatSettings(write) {
        await this.#postBatchUpdate((0, thermostat_write_1.encodeTargetTemperatureBatchUpdate)(write), 'cannot write thermostat settings');
    }
    /** Push Eco on/off through BatchUpdateState for one thermostat. */
    async updateEcoMode(resourceId, ecoOn) {
        await this.#postBatchUpdate((0, thermostat_write_1.encodeEcoModeBatchUpdate)(resourceId, ecoOn), 'cannot write thermostat Eco mode');
    }
    async #postBatchUpdate(body, stoppedMessage) {
        if (this.#isStopped) {
            throw new errors_1.ConfigurationError(`Nest transport is stopped; ${stoppedMessage}`);
        }
        const session = await this.#ensureSession();
        const started = Date.now();
        try {
            // Retried on transport-level failures only. BatchUpdateState setpoint and
            // Eco writes carry absolute values rather than deltas, so replaying one
            // is safe — and without a retry a single dropped packet silently reverts
            // the user's thermostat change.
            await (0, retry_1.withRetry)(() => (0, batch_update_1.postBatchUpdateState)({
                session,
                endpoints: this.#options.endpoints,
                body,
                signal: this.#abort.signal,
                fetchImpl: this.#options.fetchImpl,
            }), {
                maxAttempts: settings_1.BATCH_UPDATE_MAX_ATTEMPTS,
                signal: this.#abort.signal,
                isRetryable: (error) => error instanceof errors_1.NetworkError || error instanceof errors_1.TimeoutError,
                onRetry: (attempt, delayMs, error) => {
                    this.#options.metrics?.retry?.();
                    this.#options.log.debug(`BatchUpdateState attempt ${attempt} failed (${(0, sanitizers_1.sanitizeError)(error)}); retrying in ${delayMs}ms`);
                },
            });
            this.#options.metrics?.apiRequest?.(Date.now() - started, true, { networked: true });
            // Success is logged by the accessory with the HomeKit display name.
        }
        catch (error) {
            this.#options.metrics?.apiRequest?.(Date.now() - started, false, { networked: true });
            // Accessory handlers log once and revert HomeKit — do not warn here too.
            throw error;
        }
    }
    /** Stop both loops and release the session. */
    stop() {
        this.#isStopped = true;
        this.#observeSessionOpen = false;
        this.#restLoopRunning = false;
        this.#abort.abort();
        this.#session = null;
        if (this.#statusTimer) {
            clearInterval(this.#statusTimer);
            this.#statusTimer = null;
        }
        if (this.#observeSilenceTimer) {
            clearInterval(this.#observeSilenceTimer);
            this.#observeSilenceTimer = null;
        }
        if (this.#observeStartupWarnTimer) {
            clearTimeout(this.#observeStartupWarnTimer);
            this.#observeStartupWarnTimer = null;
        }
        this.#clearRestAlarmFeedStaleTimer();
        this.#emitRestAlarmFeedAvailability();
    }
    async #openSession() {
        const startedAt = Date.now();
        try {
            const session = await (0, retry_1.withRetry)(() => (0, session_1.openSession)({
                accessToken: this.#options.accessToken,
                endpoints: this.#options.endpoints,
                log: this.#options.log,
                fetchImpl: this.#options.fetchImpl,
                signal: this.#abort.signal,
            }), {
                signal: this.#abort.signal,
                onRetry: (attempt, delayMs, error) => {
                    this.#options.metrics?.retry?.();
                    this.#options.log.debug(`Session open attempt ${attempt} failed (${(0, sanitizers_1.sanitizeError)(error)}); retrying in ${delayMs}ms`);
                },
            });
            this.#options.metrics?.sessionLogin?.();
            this.#options.metrics?.apiRequest?.(Date.now() - startedAt, true);
            return session;
        }
        catch (error) {
            this.#options.metrics?.apiRequest?.(Date.now() - startedAt, false);
            throw error;
        }
    }
    /**
     * Re-open the session when it has aged out or been rejected.
     *
     * Nest reports a long `expires_in`, but a token revoked server-side keeps
     * being accepted until the first refusal, so age alone is not a reliable
     * signal and both triggers are needed. When Nest does report an expiry
     * sooner than the fixed cadence, that wins.
     *
     * Concurrent callers share one refresh. Four call sites can race — both run
     * loops, `app_launch`, and every BatchUpdateState write — and each caller
     * that arrives during an in-flight open would otherwise start its own, with
     * up to {@link MAX_REQUEST_ATTEMPTS} retries behind it. A five-thermostat
     * global Eco press against a stale session was fifteen session opens.
     */
    async #ensureSession(options = {}) {
        if (this.#session && !options.force && !this.#isSessionStale(this.#session)) {
            return this.#session;
        }
        this.#sessionRefresh ??= (async () => {
            this.#options.log.debug('Refreshing the Nest session');
            try {
                const session = await this.#openSession();
                this.#session = session;
                return session;
            }
            finally {
                this.#sessionRefresh = null;
            }
        })();
        return this.#sessionRefresh;
    }
    /** Whether a session has aged out, by Nest's own expiry or the fixed cadence. */
    #isSessionStale(session) {
        const now = Date.now();
        if (session.expiresAt !== undefined && now >= session.expiresAt - settings_1.SESSION_EXPIRY_MARGIN_MS) {
            return true;
        }
        return now - session.openedAt > settings_1.SESSION_REFRESH_MS;
    }
    /** Pull the whole account and publish it. */
    async #runAppLaunch() {
        const session = await this.#ensureSession();
        const startedAt = Date.now();
        try {
            const objects = await this.#restBreaker.execute(() => (0, retry_1.withRetry)(() => (0, rest_1.appLaunch)({
                session,
                endpoints: this.#options.endpoints,
                bucketTypes: settings_1.APP_LAUNCH_BUCKET_TYPES,
                fetchImpl: this.#options.fetchImpl,
                signal: this.#abort.signal,
            }), {
                signal: this.#abort.signal,
                onRetry: (attempt, delayMs, error) => {
                    this.#options.metrics?.retry?.();
                    this.#options.log.debug(`app_launch attempt ${attempt} failed (${(0, sanitizers_1.sanitizeError)(error)}); retrying in ${delayMs}ms`);
                },
            }), { isFailure: errors_1.isCircuitBreakerFailure });
            this.#lastAppLaunchAt = Date.now();
            const snapshot = this.#objects.applyAppLaunchSnapshot(objects);
            if (snapshot.truncated) {
                this.#options.log.warn(`app_launch incomplete (${objects.length} objects, had ${snapshot.previousCount}) — keeping prior REST state`);
            }
            else if (snapshot.dropped.length > 0) {
                this.#options.log.info(`REST dropped ${snapshot.dropped.length} object(s) from inventory`);
            }
            this.#publishBuckets();
            this.#options.metrics?.apiRequest?.(Date.now() - startedAt, true);
            this.#options.metrics?.restCycle?.(true, Date.now() - startedAt);
            this.#noteRestSuccess();
        }
        catch (error) {
            const networked = !(error instanceof errors_1.CircuitBreakerError);
            this.#options.metrics?.apiRequest?.(Date.now() - startedAt, false, networked);
            this.#options.metrics?.restCycle?.(false, Date.now() - startedAt);
            this.#emitRestAlarmFeedAvailability();
            throw error;
        }
    }
    /**
     * Keep an Observe stream running for as long as the plugin does.
     *
     * Every exit from a single connection is expected at some point — Nest
     * recycles them, the network drops, a stream goes quiet — so the loop treats
     * a clean end and a failure the same way and simply reconnects. Only a
     * rejected token stops it.
     */
    async #runObserveLoop() {
        let consecutiveFailures = 0;
        let isFirstSession = true;
        while (!this.#isStopped) {
            try {
                const session = await this.#ensureSession();
                this.#observeSessionOpen = true;
                if (!isFirstSession) {
                    this.#options.metrics?.observeReconnect?.();
                }
                isFirstSession = false;
                this.#options.onObserveSessionStart?.();
                const result = await this.#observeBreaker.execute(() => (0, observe_1.runObserveSession)({
                    session,
                    endpoints: this.#options.endpoints,
                    log: this.#options.log,
                    connect: this.#options.connect,
                    signal: this.#abort.signal,
                    onFrame: (frame) => this.#handleObserveFrame(frame),
                }), { isFailure: errors_1.isCircuitBreakerFailure });
                this.#observeSessionOpen = false;
                if (result.reason === 'aborted') {
                    return;
                }
                // Only a stream that did real work clears the backoff. Nest sends a
                // resource catalogue as frame 0 on every connection, so `frameCount > 0`
                // alone is also true of a gateway that accepts, emits that one frame,
                // and immediately drops — which would pin the reconnect delay at the
                // 5s base forever with no escalation.
                const wasProductive = result.frameCount > 1
                    || result.durationMs >= settings_1.OBSERVE_PRODUCTIVE_SESSION_MS;
                if (wasProductive) {
                    consecutiveFailures = 0;
                    this.#observeForbidden = 0;
                    this.#noteLoopSuccess('observe');
                }
                else {
                    consecutiveFailures++;
                }
                this.#options.log.debug(`Observe stream ended (${result.reason}) after ${result.frameCount} frame(s) in ${Math.round(result.durationMs / 1000)}s`);
            }
            catch (error) {
                this.#observeSessionOpen = false;
                if (this.#isStopped) {
                    return;
                }
                if (!(await this.#handleLoopError('Observe stream', error, 'observe'))) {
                    return;
                }
                if (!(error instanceof errors_1.CircuitBreakerError)) {
                    consecutiveFailures++;
                }
                if (!(await this.#waitBeforeReconnect(consecutiveFailures, error))) {
                    return;
                }
                continue;
            }
            if (!(await this.#waitBeforeReconnect(consecutiveFailures))) {
                return;
            }
        }
    }
    /**
     * Track how many recent frames failed to parse, and say so if most of them do.
     *
     * A pinned `WEB_APP_VERSION` against an unversioned private API means a Nest
     * schema change is the most likely way this plugin breaks. Its signature is
     * every frame decoding to nothing while `observeFrames` climbs and health
     * stays healthy — completely silent without this.
     */
    #noteFrameDecode(isUndecodable) {
        this.#recentFrameOutcomes.push(isUndecodable);
        if (this.#recentFrameOutcomes.length > settings_1.FRAME_DECODE_WINDOW) {
            this.#recentFrameOutcomes.shift();
        }
        if (this.#recentFrameOutcomes.length < settings_1.FRAME_DECODE_WINDOW || this.#didWarnDecodeRate) {
            return;
        }
        const failed = this.#recentFrameOutcomes.filter(Boolean).length;
        if (failed / this.#recentFrameOutcomes.length > settings_1.FRAME_DECODE_FAILURE_RATIO) {
            this.#didWarnDecodeRate = true;
            this.#options.log.warn(`${failed} of the last ${this.#recentFrameOutcomes.length} Observe frames could not be `
                + 'decoded — Nest may have changed its trait schema, so readings will be stale.');
        }
    }
    /**
     * Hand the merged bucket map to the platform.
     *
     * Kept outside the callers' network try/catch. A throw from platform-side
     * state merging is not a Nest failure, and counting it as one drove the
     * circuit breaker, forced a session refresh, and reported a local bug to the
     * operator as a connectivity problem — while never naming the real fault.
     */
    #publishBuckets() {
        let buckets;
        try {
            buckets = this.#objects.toBuckets();
        }
        catch (error) {
            this.#options.log.error(`Could not index Nest REST buckets: ${(0, sanitizers_1.sanitizeError)(error)}`);
            return;
        }
        try {
            this.#options.onBuckets(buckets);
        }
        catch (error) {
            this.#options.log.error(`Could not apply Nest REST buckets: ${(0, sanitizers_1.sanitizeError)(error)}`);
        }
    }
    #handleObserveFrame(frame) {
        this.#observeFrames++;
        this.#lastObserveFrameAt = Date.now();
        const { traits, status, isUndecodable } = (0, protobuf_1.decodeFrame)(frame);
        this.#noteFrameDecode(isUndecodable === true);
        // The first frame of every connection is a resource catalogue in a shape
        // `StreamBody` does not describe, so an empty decode is routine rather
        // than a problem worth reporting.
        if (status?.code !== undefined && status.code !== 0) {
            this.#options.log.debug(`Observe stream reported status ${status.code}${status.message ? `: ${status.message}` : ''}`);
        }
        if (traits.length > 0) {
            this.#options.onTraits(traits);
        }
    }
    /**
     * Long-poll REST for changes, re-enumerating the account periodically.
     *
     * The long-poll only reports buckets the client already knows about, so it
     * can never reveal a newly added device. That is what the periodic
     * `app_launch` is for.
     */
    async #runSubscribeLoop() {
        let consecutiveFailures = 0;
        this.#restLoopRunning = true;
        while (!this.#isStopped) {
            // Re-check before each attempt so an age-based stale flip during backoff
            // still notifies the platform even if the timer was cleared somehow.
            this.#emitRestAlarmFeedAvailability();
            const cycleStartedAt = Date.now();
            try {
                if (Date.now() - this.#lastAppLaunchAt >= settings_1.REDISCOVERY_INTERVAL_MS) {
                    await this.#runAppLaunch();
                }
                const session = await this.#ensureSession();
                const result = await this.#restBreaker.execute(() => (0, rest_1.subscribeOnce)({
                    session,
                    endpoints: this.#options.endpoints,
                    revisions: this.#objects.revisions,
                    fetchImpl: this.#options.fetchImpl,
                    signal: this.#abort.signal,
                }), { isFailure: errors_1.isCircuitBreakerFailure });
                this.#restCycles++;
                consecutiveFailures = 0;
                this.#restForbidden = 0;
                this.#noteLoopSuccess('rest');
                // Subscribe is a long-poll by design (idle or not). Never fold its wait
                // into API latency percentiles — session/app_launch remain the samples.
                this.#options.metrics?.apiRequest?.(Date.now() - cycleStartedAt, true, {
                    sampleLatency: false,
                });
                this.#options.metrics?.restCycle?.(true, Date.now() - cycleStartedAt);
                this.#noteRestSuccess();
                if (!result.isIdle) {
                    this.#objects.merge(result.objects);
                    this.#publishBuckets();
                }
            }
            catch (error) {
                if (this.#isStopped) {
                    this.#restLoopRunning = false;
                    return;
                }
                const networked = !(error instanceof errors_1.CircuitBreakerError);
                this.#options.metrics?.apiRequest?.(Date.now() - cycleStartedAt, false, {
                    networked,
                    sampleLatency: false,
                });
                this.#options.metrics?.restCycle?.(false, Date.now() - cycleStartedAt);
                this.#emitRestAlarmFeedAvailability();
                if (!(await this.#handleLoopError('REST subscribe', error, 'rest'))) {
                    this.#restLoopRunning = false;
                    this.#emitRestAlarmFeedAvailability();
                    return;
                }
                if (!(error instanceof errors_1.CircuitBreakerError)) {
                    consecutiveFailures++;
                }
                if (!(await this.#waitBeforeReconnect(consecutiveFailures, error))) {
                    this.#restLoopRunning = false;
                    return;
                }
                continue;
            }
            // Success path (including idle / converted 502) must still rate-limit.
            // Without this floor a Nest edge outage turns every install into an
            // unthrottled request loop.
            const elapsed = Date.now() - cycleStartedAt;
            if (elapsed < settings_1.MIN_SUBSCRIBE_CYCLE_MS) {
                await (0, retry_1.sleep)(settings_1.MIN_SUBSCRIBE_CYCLE_MS - elapsed, this.#abort.signal);
            }
        }
    }
    /**
     * Decide whether a loop can carry on after a failure.
     *
     * HTTP 403 counters are per-transport. A WAF blip on REST must not tear down
     * a healthy Observe stream (and vice versa). Only when *both* loops have
     * exhausted their 403 budget does the plugin treat the token as dead.
     *
     * @returns `false` when the loop must stop, having already reported why.
     */
    async #handleLoopError(context, error, transport) {
        if (this.#abort.signal.aborted) {
            return false;
        }
        if (error instanceof errors_1.AuthenticationError || error instanceof errors_1.ConfigurationError) {
            this.#options.onFatal(error);
            return false;
        }
        // Fail-fast cooldown: do not force a session refresh or treat this as a
        // Nest HTTP failure — the transport simply waits out the breaker.
        if (error instanceof errors_1.CircuitBreakerError) {
            this.#options.log.debug(`${context}: ${(0, sanitizers_1.sanitizeError)(error)}`);
            return true;
        }
        if (error instanceof errors_1.ForbiddenError) {
            const count = transport === 'observe'
                ? ++this.#observeForbidden
                : ++this.#restForbidden;
            this.#options.log.warn(`${context} returned HTTP 403 (${count}/${settings_1.FORBIDDEN_FATAL_THRESHOLD}): ${(0, sanitizers_1.sanitizeError)(error)}`);
            if (count >= settings_1.FORBIDDEN_FATAL_THRESHOLD) {
                if (transport === 'observe') {
                    this.#observeForbiddenDead = true;
                }
                else {
                    this.#restForbiddenDead = true;
                }
                if (this.#observeForbiddenDead && this.#restForbiddenDead) {
                    this.#options.onFatal(new errors_1.AuthenticationError(`Nest returned HTTP 403 on both REST and Observe ${settings_1.FORBIDDEN_FATAL_THRESHOLD} times — token may be revoked; get a fresh one from https://home.nest.com/session.`, { cause: error }));
                }
                else {
                    this.#options.log.error(`${context} giving up after ${count} HTTP 403s — other transport keeps running if it can.`);
                }
                return false;
            }
        }
        else {
            this.#reportLoopFailure(context, error, transport);
        }
        // Only an auth-shaped failure justifies re-opening the session. Forcing a
        // refresh on every retryable error turned one failed request into up to
        // four (the open itself retries), did it on both loops at once during any
        // shared outage, and — worst — responded to an HTTP 429 by issuing more
        // requests. A DNS blip says nothing about whether the session is valid.
        if (this.#isSessionSuspect(error)) {
            try {
                await this.#ensureSession({ force: true });
            }
            catch (refreshError) {
                if (refreshError instanceof errors_1.AuthenticationError) {
                    this.#options.onFatal(refreshError);
                    return false;
                }
                this.#options.log.debug(`Session refresh failed: ${(0, sanitizers_1.sanitizeError)(refreshError)}`);
            }
        }
        return true;
    }
    /** Whether a failure is plausibly the session being rejected. */
    #isSessionSuspect(error) {
        if (error instanceof errors_1.ForbiddenError) {
            return true;
        }
        return error instanceof errors_1.ApiResponseError && error.httpStatus === 401;
    }
    /**
     * Report a transport failure at a level an operator will actually see.
     *
     * Logging every non-403 failure at debug meant a persistently broken plugin
     * was silent by default: a sub-500 status neither trips the breaker nor
     * counts toward the 403 budget, so nothing else surfaced it either. The first
     * failure and every tenth after it are warnings; the rest stay at debug so a
     * flapping connection cannot flood the log.
     */
    #reportLoopFailure(context, error, transport) {
        const streak = transport === 'observe'
            ? ++this.#observeFailureStreak
            : ++this.#restFailureStreak;
        const status = error instanceof errors_1.NestError && error.httpStatus !== undefined
            ? ` HTTP ${error.httpStatus}`
            : '';
        const code = error instanceof errors_1.NestError ? ` ${error.code}` : '';
        const line = `${context} failed (${streak} in a row,${code}${status}): ${(0, sanitizers_1.sanitizeError)(error)}`;
        const summary = error instanceof errors_1.NestError ? error.code : 'UNKNOWN';
        if (transport === 'observe') {
            this.#lastObserveError = summary;
        }
        else {
            this.#lastRestError = summary;
        }
        if (streak === 1 || streak % settings_1.LOOP_FAILURE_WARN_EVERY === 0) {
            this.#options.log.warn(line);
        }
        else {
            this.#options.log.debug(line);
        }
    }
    /** Clear a transport's failure streak after a good cycle. */
    #noteLoopSuccess(transport) {
        if (transport === 'observe') {
            this.#observeFailureStreak = 0;
        }
        else {
            this.#restFailureStreak = 0;
        }
    }
    /** @returns `false` when the wait was cut short by shutdown. */
    async #waitBeforeReconnect(consecutiveFailures, error) {
        if (this.#isStopped) {
            return false;
        }
        // Honour the breaker's cooldown so loops do not spin while open.
        if (error instanceof errors_1.CircuitBreakerError) {
            await (0, retry_1.sleep)(error.retryAfterMs || settings_1.RECONNECT_BASE_MS, this.#abort.signal);
            return !this.#isStopped;
        }
        // A clean end reconnects promptly; a failing one backs off. Without the
        // distinction, Nest's routine stream recycling would be punished with a
        // growing delay and thermostats would go minutes without updates.
        const serverDelay = error instanceof errors_1.RateLimitError ? error.retryAfterMs : undefined;
        const delayMs = consecutiveFailures === 0
            ? settings_1.RECONNECT_BASE_MS
            : serverDelay ?? (0, retry_1.computeBackoffMs)(consecutiveFailures);
        await (0, retry_1.sleep)(delayMs, this.#abort.signal);
        return !this.#isStopped;
    }
    /**
     * Periodic operator-visible status so a dead Observe loop is not silent.
     *
     * Reports deltas and ages rather than cumulative totals: a running count
     * requires the reader to diff two lines fifteen minutes apart to learn
     * anything, and this is the only signal that is on by default.
     */
    #startStatusHeartbeat() {
        let previousFrames = this.#observeFrames;
        let previousCycles = this.#restCycles;
        this.#statusTimer = setInterval(() => {
            const status = this.status;
            const frameDelta = status.observeFrames - previousFrames;
            const cycleDelta = status.restCycles - previousCycles;
            previousFrames = status.observeFrames;
            previousCycles = status.restCycles;
            const observeAge = status.lastObserveFrameAgeSec ?? '-';
            const restAge = status.lastRestSuccessAgeSec ?? '-';
            const breakers = `rest=${status.circuitBreaker.rest.state} obs=${status.circuitBreaker.observe.state}`;
            this.#options.log.info(`Nest transport: +${frameDelta} Observe frame(s), +${cycleDelta} REST cycle(s), `
                + `${status.knownObjects} known object(s); last Observe ${observeAge}s ago, `
                + `last REST ${restAge}s ago; alarm feed `
                + `${status.isRestAlarmFeedAvailable ? 'live' : 'STALE'}; breaker ${breakers}`);
        }, this.#options.statusHeartbeatMs ?? settings_1.STATUS_HEARTBEAT_MS);
        this.#statusTimer.unref?.();
    }
    /**
     * Standing alarm for an Observe stream that stopped delivering.
     *
     * The startup warning is one-shot, so a stream that is healthy at 60s and
     * dies at hour five produced no warning at all — despite Observe being the
     * only source of thermostat state on modern accounts.
     */
    #startObserveSilenceWatch() {
        this.#observeSilenceTimer = setInterval(() => {
            if (this.#isStopped || this.#observeForbiddenDead) {
                return;
            }
            const ageSec = this.status.lastObserveFrameAgeSec;
            if (ageSec !== null && ageSec * 1_000 > settings_1.OBSERVE_IDLE_TIMEOUT_MS) {
                this.#options.log.warn(`Observe has delivered no frames for ${ageSec}s — thermostat readings are stale.`);
            }
        }, this.#options.observeSilenceCheckMs ?? settings_1.OBSERVE_SILENCE_CHECK_MS);
        this.#observeSilenceTimer.unref?.();
    }
    #scheduleObserveStartupWarn() {
        if (this.#observeStartupWarnTimer) {
            clearTimeout(this.#observeStartupWarnTimer);
        }
        this.#observeStartupWarnTimer = setTimeout(() => {
            this.#observeStartupWarnTimer = null;
            if (this.#isStopped || this.#observeFrames > 0 || this.#didWarnObserveSilent) {
                return;
            }
            this.#didWarnObserveSilent = true;
            this.#options.log.warn('Observe produced no frames since startup — thermostats / Observe-only Protects wait until it connects.');
        }, settings_1.OBSERVE_STARTUP_WARN_MS);
        this.#observeStartupWarnTimer.unref?.();
    }
}
exports.NestTransport = NestTransport;
//# sourceMappingURL=transport.js.map