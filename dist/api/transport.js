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
const alarm_feed_1 = require("./alarm-feed");
const classify_1 = require("../state/classify");
const retry_1 = require("../utils/retry");
const sanitizers_1 = require("../utils/sanitizers");
/** Owns the Nest session and both read loops. */
class NestTransport {
    #options;
    #objects = new rest_1.ObjectList();
    #abort = new AbortController();
    /** Guards `/v5/subscribe` on the account's transport host. */
    #restBreaker;
    /**
     * Guards `app_launch` on the API host. Separate from {@link #restBreaker}
     * because the hosts fail independently, and an `app_launch` outage must not
     * block the subscribe that carries Protect alarms.
     */
    #appLaunchBreaker;
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
    #isDecodeDegraded = false;
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
    #forbiddenReprobeTimers = new Map();
    #observeStartupWarnTimer = null;
    #lastObserveFrameAt = null;
    /** Decoded `DEVICE_` traits in the Observe session that is open now. */
    #decodedDeviceTraitsThisSession = 0;
    #loopRestartTimers = new Map();
    #observeSessionOpen = false;
    #restLoopRunning = false;
    /** True once the subscribe loop has started, so its exit can be told apart from startup. */
    #hasRestLoopStarted = false;
    #alarmFeed = new alarm_feed_1.AlarmFeedClock();
    #wasRestAlarmFeedAvailable = false;
    /** True after this process has logged that the alarm feed went unavailable. */
    #announcedAlarmFeedDown = false;
    #restAlarmFeedStaleTimer = null;
    constructor(options) {
        this.#options = options;
        this.#restBreaker = options.restCircuitBreaker ?? new circuit_breaker_1.CircuitBreaker();
        this.#appLaunchBreaker = options.appLaunchCircuitBreaker ?? new circuit_breaker_1.CircuitBreaker();
        this.#observeBreaker = options.observeCircuitBreaker ?? new circuit_breaker_1.CircuitBreaker();
        this.#wireBreaker(this.#restBreaker, 'rest', 'REST');
        this.#wireBreaker(this.#appLaunchBreaker, 'rest', 'REST refresh');
        this.#wireBreaker(this.#observeBreaker, 'observe', 'Observe');
    }
    /** Attach logging + trip callback for one transport breaker. */
    #wireBreaker(breaker, transport, label) {
        breaker.attachOnStateChange((from, to) => {
            if (to === circuit_breaker_1.CircuitState.OPEN) {
                // Often the first default-visible sign of trouble, so it names the
                // cause and the cooldown.
                const last = transport === 'observe' ? this.#lastObserveError : this.#lastRestError;
                const cause = last ? ` (${last})` : '';
                const cooldown = breaker.getStatus().remainingResetTimeMs;
                const retry = cooldown !== null ? `, retrying in ${Math.round(cooldown / 1000)}s` : '';
                this.#options.log.warn(`${label}: paused after repeated failures${cause}${retry}`);
            }
            else if (to === circuit_breaker_1.CircuitState.CLOSED) {
                this.#options.log.info(`${label}: recovered`);
            }
            else {
                this.#options.log.debug(`${label}: circuit ${from} -> ${to}`);
            }
            if (to === circuit_breaker_1.CircuitState.OPEN && from !== circuit_breaker_1.CircuitState.OPEN) {
                this.#options.onCircuitOpen?.(transport);
            }
            if (breaker === this.#restBreaker) {
                this.#emitRestAlarmFeedAvailability();
            }
        });
    }
    get status() {
        const lastObserveFrameAgeSec = this.#lastObserveFrameAt === null
            ? null
            : Math.round((Date.now() - this.#lastObserveFrameAt) / 1000);
        const lastRefreshAt = this.#alarmFeed.lastRefreshAt;
        const lastRestSuccessAgeSec = lastRefreshAt === null
            ? null
            : Math.round((Date.now() - lastRefreshAt) / 1000);
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
            isDecodeDegraded: this.#isDecodeDegraded,
            circuitBreaker: {
                rest: this.#restBreaker.getStatus(),
                observe: this.#observeBreaker.getStatus(),
            },
        };
    }
    /** Whether cached REST topaz may still be treated as a live Protect alarm feed. */
    #computeRestAlarmFeedAvailable() {
        return this.#alarmFeed.isLive(Date.now(), {
            isStopped: this.#isStopped,
            isForbiddenDead: this.#restForbiddenDead,
            hasLoopExited: this.#hasRestLoopStarted && !this.#restLoopRunning,
            isBreakerClosed: this.#restBreaker.state === circuit_breaker_1.CircuitState.CLOSED,
        });
    }
    /** Record a REST read that refreshes Protect alarm state. */
    #recordRestRefresh(refresh) {
        this.#alarmFeed.record(refresh, Date.now());
        this.#armRestAlarmFeedStaleTimer();
        this.#emitRestAlarmFeedAvailability();
    }
    /**
     * Fire {@link #emitRestAlarmFeedAvailability} when either clock ages out,
     * even if the subscribe loop is sleeping through a long backoff.
     */
    #armRestAlarmFeedStaleTimer() {
        this.#clearRestAlarmFeedStaleTimer();
        const expiresAt = this.#alarmFeed.ageExpiresAt();
        if (expiresAt === null) {
            return;
        }
        const remainingMs = expiresAt - Date.now();
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
        const wasAvailable = this.#wasRestAlarmFeedAvailable;
        this.#wasRestAlarmFeedAvailable = available;
        // A return to normal is not a warning. The first success of the process
        // is not a restore: the feed has not been down yet.
        if (available) {
            if (!wasAvailable && this.#announcedAlarmFeedDown) {
                this.#options.log.info('Protect alarm feed restored');
                this.#announcedAlarmFeedDown = false;
            }
        }
        else if (wasAvailable) {
            this.#announcedAlarmFeedDown = true;
            this.#options.log.warn('Protect alarm feed unavailable, smoke/CO marked inactive');
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
     * @throws {AuthenticationError} When the token is rejected.
     * @throws {SessionShapeError} When the session is one this plugin cannot use.
     *   Nothing can proceed without a session, so both are surfaced rather than retried.
     */
    async start() {
        this.#session = await this.#openSession();
        await this.#runAppLaunch();
        // Both loops run for the life of the plugin and are never awaited. Their
        // bodies are guarded, but their catch handlers are not, so an unhandled
        // rejection here would terminate the whole Homebridge process under Node's
        // default `--unhandled-rejections=throw` — taking every other plugin down.
        this.#startLoop('Observe', () => this.#runObserveLoop());
        this.#startLoop('REST', () => this.#runSubscribeLoop());
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
        for (const timer of this.#forbiddenReprobeTimers.values()) {
            clearTimeout(timer);
        }
        this.#forbiddenReprobeTimers.clear();
        if (this.#observeStartupWarnTimer) {
            clearTimeout(this.#observeStartupWarnTimer);
            this.#observeStartupWarnTimer = null;
        }
        this.#clearRestAlarmFeedStaleTimer();
        for (const timer of this.#loopRestartTimers.values()) {
            clearTimeout(timer);
        }
        this.#loopRestartTimers.clear();
        // Deliberately not emitting availability here. `#isStopped` forces the feed
        // to compute as unavailable, so an orderly shutdown would log a
        // fault-shaped warning on every restart — training operators who alert on
        // warn to ignore the one message that matters during a real outage.
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
     * Re-open the session when it has aged out.
     *
     * A rejected session (HTTP 401) is fatal rather than a refresh trigger: the
     * session is derived from the configured token, so a new one would be
     * rejected too. When Nest reports an expiry sooner than the fixed cadence,
     * that wins.
     *
     * Concurrent callers share one refresh. Four call sites can race — both run
     * loops, `app_launch`, and every BatchUpdateState write — and each caller
     * that arrives during an in-flight open would otherwise start its own, with
     * up to `MAX_REQUEST_ATTEMPTS` retries behind it. A five-thermostat
     * global Eco press against a stale session was fifteen session opens.
     */
    async #ensureSession() {
        if (this.#session && !this.#isSessionStale(this.#session)) {
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
        // Recorded before the call so a failing or truncated launch still spaces
        // the next scheduled one.
        this.#lastAppLaunchAt = Date.now();
        const session = await this.#ensureSession();
        const startedAt = Date.now();
        try {
            const objects = await this.#appLaunchBreaker.execute(() => (0, retry_1.withRetry)(() => (0, rest_1.appLaunch)({
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
            const snapshot = this.#objects.applyAppLaunchSnapshot(objects);
            if (snapshot.truncated) {
                this.#options.log.warn(`REST: incomplete device list (${objects.length} of ${snapshot.previousCount}), keeping prior state`);
            }
            else if (snapshot.dropped.length > 0) {
                this.#options.log.debug(`REST: ${snapshot.dropped.length} object(s) no longer listed`);
            }
            this.#publishBuckets(objects.map((object) => object.object_key));
            this.#options.metrics?.apiRequest?.(Date.now() - startedAt, true);
            this.#options.metrics?.restCycle?.(true, Date.now() - startedAt);
            // A truncated body omitted Protects, so it is not a refresh for them.
            if (!snapshot.truncated) {
                this.#recordRestRefresh('answered');
            }
        }
        catch (error) {
            if (this.#isStopped) {
                throw error;
            }
            const networked = !(error instanceof errors_1.CircuitBreakerError);
            this.#options.metrics?.apiRequest?.(Date.now() - startedAt, false, networked);
            this.#options.metrics?.restCycle?.(false, Date.now() - startedAt);
            throw error;
        }
    }
    /**
     * Which scheduled `app_launch` is due before the next subscribe, if any.
     *
     * `app_launch` doubles as a proof of life. The subscribe long-poll can
     * legitimately time out with no response on a quiet house, so without a
     * call that always produces a real answer there is no way to tell a
     * silent-but-healthy account from a route that is swallowing traffic. A
     * truncated or failed launch does not refresh the answer clock, so the age
     * check alone would launch on every cycle. The attempt time spaces them.
     */
    #dueAppLaunch() {
        const now = Date.now();
        const sinceLaunchMs = now - this.#lastAppLaunchAt;
        const lastAnsweredAt = this.#alarmFeed.lastAnsweredAt;
        const isAnswerOld = lastAnsweredAt === null || now - lastAnsweredAt >= settings_1.REST_PROOF_OF_LIFE_MS;
        if (isAnswerOld && sinceLaunchMs >= settings_1.REST_PROOF_OF_LIFE_MS) {
            return 'proof_of_life';
        }
        return sinceLaunchMs >= settings_1.REDISCOVERY_INTERVAL_MS ? 'rediscovery' : null;
    }
    /**
     * Run a due `app_launch` without letting its failure block the subscribe.
     *
     * The two calls go to different hosts. Subscribe still runs after a failed
     * launch, so Protect alarms keep arriving while the API host is down.
     *
     * @returns `false` when the loop must stop, having already reported why.
     */
    async #runDueAppLaunch() {
        const due = this.#dueAppLaunch();
        if (due === null) {
            return true;
        }
        if (due === 'proof_of_life') {
            this.#options.log.debug('No REST response from Nest recently; running app_launch to confirm reachability');
        }
        try {
            await this.#runAppLaunch();
            return true;
        }
        catch (error) {
            if (this.#isStopped) {
                return false;
            }
            return this.#handleLoopError('REST refresh', error, 'rest');
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
            this.#decodedDeviceTraitsThisSession = 0;
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
                // Only a stream that delivered a device trait clears the backoff.
                // Nest sends a resource catalogue as frame 0 on every connection, so
                // frame count and a long-lived silent socket are not evidence the
                // thermostat path is alive.
                const wasProductive = this.#decodedDeviceTraitsThisSession > 0;
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
                // A stream that delivered device data and then dropped was healthy
                // while it lasted. Without this, routine resets after productive
                // sessions climb the backoff to its cap.
                if (this.#decodedDeviceTraitsThisSession > 0) {
                    consecutiveFailures = 0;
                    this.#observeForbidden = 0;
                    this.#noteLoopSuccess('observe');
                }
                if (!this.#handleLoopError('Observe', error, 'observe')) {
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
        if (this.#recentFrameOutcomes.length < settings_1.FRAME_DECODE_WINDOW) {
            return;
        }
        const failed = this.#recentFrameOutcomes.filter(Boolean).length;
        const isDegraded = failed / this.#recentFrameOutcomes.length > settings_1.FRAME_DECODE_FAILURE_RATIO;
        // Held as state rather than a one-shot warning. A schema change is the most
        // likely way this plugin breaks, and its signature is every frame decoding
        // to nothing while `observeFrames` climbs and the stream reports connected —
        // so a single log line that scrolls away leaves the plugin reporting perfect
        // health while every reading in the house is frozen.
        if (isDegraded === this.#isDecodeDegraded) {
            return;
        }
        this.#isDecodeDegraded = isDegraded;
        if (isDegraded) {
            this.#options.log.warn(`Observe: ${failed} of the last ${this.#recentFrameOutcomes.length} updates unreadable, Nest may have changed its format`);
        }
        else {
            this.#options.log.info('Observe: updates readable again');
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
    #publishBuckets(updatedKeys) {
        let buckets;
        try {
            buckets = this.#objects.toBuckets();
        }
        catch (error) {
            this.#options.log.error(`REST: could not read update: ${(0, sanitizers_1.sanitizeError)(error)}`);
            return;
        }
        try {
            this.#options.onBuckets(buckets, updatedKeys);
        }
        catch (error) {
            this.#options.log.error(`REST: could not apply update: ${(0, sanitizers_1.sanitizeError)(error)}`);
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
        // Observe sends device traits only on change, so a quiet house can go a
        // long time without one. This counts them only to judge a session productive.
        if (traits.some((trait) => trait.resourceId.startsWith(classify_1.OBSERVE_DEVICE_PREFIX))) {
            this.#decodedDeviceTraitsThisSession++;
        }
        if (traits.length > 0) {
            this.#options.onTraits(traits);
        }
    }
    /**
     * Run a transport loop, and start it again if it throws.
     *
     * A normal return (shutdown, auth failure, 403 reprobe) does not come
     * through here. The 403 path schedules its own reprobe.
     */
    #startLoop(label, run) {
        void run().catch((error) => {
            if (label === 'REST') {
                this.#restLoopRunning = false;
                this.#emitRestAlarmFeedAvailability();
            }
            this.#options.log.error(`${label}: stopped unexpectedly: ${(0, sanitizers_1.sanitizeError)(error)}`);
            if (this.#isStopped) {
                return;
            }
            const existing = this.#loopRestartTimers.get(label);
            if (existing) {
                clearTimeout(existing);
            }
            const timer = setTimeout(() => {
                this.#loopRestartTimers.delete(label);
                if (this.#isStopped) {
                    return;
                }
                this.#options.log.info(`${label}: restarting`);
                this.#startLoop(label, run);
            }, settings_1.RECONNECT_BASE_MS);
            timer.unref?.();
            this.#loopRestartTimers.set(label, timer);
        });
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
        this.#hasRestLoopStarted = true;
        while (!this.#isStopped) {
            // Re-check before each attempt so an age-based stale flip during backoff
            // still notifies the platform even if the timer was cleared somehow.
            this.#emitRestAlarmFeedAvailability();
            if (!(await this.#runDueAppLaunch())) {
                this.#restLoopRunning = false;
                // Shutdown is not an outage; see `stop()`.
                if (!this.#isStopped) {
                    this.#emitRestAlarmFeedAvailability();
                }
                return;
            }
            const cycleStartedAt = Date.now();
            try {
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
                // Subscribe sends revisions for every known object, so an answer,
                // even an empty one, covers all of them.
                this.#recordRestRefresh(result.hadResponse ? 'answered' : 'unanswered');
                if (!result.isIdle) {
                    this.#objects.merge(result.objects);
                    this.#publishBuckets(result.objects.map((object) => object.object_key));
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
                if (!this.#handleLoopError('REST', error, 'rest')) {
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
     * HTTP 403 counters are per-transport. A 403 does not mean the token is
     * revoked, on one transport or on both. Each transport probes again after
     * its cooldown. HTTP 401 and a session this plugin cannot use are the stop.
     *
     * @returns `false` when the loop must stop, having already reported why.
     */
    #handleLoopError(context, error, transport) {
        if (this.#abort.signal.aborted) {
            return false;
        }
        if ((0, errors_1.isFatalTransportError)(error)) {
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
            this.#options.log.warn(`${context}: HTTP 403 (${count}/${settings_1.FORBIDDEN_FATAL_THRESHOLD})`);
            if (count >= settings_1.FORBIDDEN_FATAL_THRESHOLD) {
                if (transport === 'observe') {
                    this.#observeForbiddenDead = true;
                }
                else {
                    this.#restForbiddenDead = true;
                }
                // A 403 is the edge refusing this client. It is not proof the token
                // was revoked, including when both transports hit the budget. Tell
                // the operator that, and probe again after the cooldown.
                const minutes = Math.round((this.#options.forbiddenReprobeMs ?? settings_1.FORBIDDEN_REPROBE_MS) / 60_000);
                this.#options.log.error(`${context}: blocked by Nest (HTTP 403), retrying in ${minutes} min`);
                this.#scheduleForbiddenReprobe(transport);
                return false;
            }
        }
        else {
            this.#reportLoopFailure(context, error, transport);
        }
        // No forced session refresh here. HTTP 401 is fatal above, and refreshing
        // on a retryable error turns one failed request into several, on both
        // loops at once, including in answer to a 429 or a 403 edge block.
        return true;
    }
    /**
     * Bring a 403-dead transport back after a cooling-off period.
     *
     * Fail-fast is right; permanent is not. A WAF block clears on its own, and the
     * plugin has no other way to notice that it has.
     */
    #scheduleForbiddenReprobe(transport) {
        if (this.#isStopped || this.#forbiddenReprobeTimers.has(transport)) {
            return;
        }
        const timer = setTimeout(() => {
            this.#forbiddenReprobeTimers.delete(transport);
            if (this.#isStopped) {
                return;
            }
            this.#options.log.info(`${transport === 'rest' ? 'REST' : 'Observe'}: retrying after HTTP 403 cooldown`);
            if (transport === 'observe') {
                this.#observeForbiddenDead = false;
                this.#observeForbidden = 0;
                this.#startLoop('Observe', () => this.#runObserveLoop());
            }
            else {
                this.#restForbiddenDead = false;
                this.#restForbidden = 0;
                this.#emitRestAlarmFeedAvailability();
                this.#startLoop('REST', () => this.#runSubscribeLoop());
            }
        }, this.#options.forbiddenReprobeMs ?? settings_1.FORBIDDEN_REPROBE_MS);
        timer.unref?.();
        this.#forbiddenReprobeTimers.set(transport, timer);
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
        const line = `${context}: failed ${streak}x in a row: ${(0, sanitizers_1.sanitizeError)(error)}`;
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
            this.#options.log.info(`Status: Observe +${frameDelta} (last ${observeAge}s ago), REST +${cycleDelta} (last ${restAge}s ago), `
                + `alarm feed ${status.isRestAlarmFeedAvailable ? 'live' : 'STALE'}`);
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
            // `null` means Observe has *never* delivered a frame — strictly worse than
            // a stream that went quiet, and previously invisible here because the
            // check required a non-null age. That case got one warning at the 60s mark
            // and nothing afterwards, while HomeKit had no thermostats at all.
            const ageSec = this.status.lastObserveFrameAgeSec;
            if (ageSec === null) {
                this.#options.log.warn('Observe: never connected, thermostats unavailable');
            }
            else if (ageSec * 1_000 > settings_1.OBSERVE_IDLE_TIMEOUT_MS) {
                this.#options.log.warn(`Observe: no data for ${ageSec}s, thermostat readings stale`);
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
            this.#options.log.warn('Observe: no data since startup, still connecting');
        }, settings_1.OBSERVE_STARTUP_WARN_MS);
        this.#observeStartupWarnTimer.unref?.();
    }
}
exports.NestTransport = NestTransport;
