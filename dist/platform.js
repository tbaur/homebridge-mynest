"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The Homebridge platform: discovery, state, and the update path.
 *
 * The platform owns the merged view of the home. Both transports hand it raw
 * updates, it folds them into the two state stores, rebuilds the inventory, and
 * pushes the result to accessories. Devices are published from the union of
 * both transports, because on a real account neither one sees the whole house.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MyNestPlatform = void 0;
const settings_1 = require("./settings");
const device_1 = require("./types/device");
const errors_1 = require("./errors");
const transport_1 = require("./api/transport");
const thermostat_write_1 = require("./api/thermostat-write");
const collector_1 = require("./diagnostics/collector");
const format_1 = require("./diagnostics/format");
const classify_1 = require("./state/classify");
const observe_state_1 = require("./state/observe-state");
const registry_1 = require("./state/registry");
const validators_1 = require("./utils/validators");
const logger_1 = require("./utils/logger");
const retry_1 = require("./utils/retry");
const sanitizers_1 = require("./utils/sanitizers");
const global_eco_1 = require("./accessories/global-eco");
const protect_1 = require("./accessories/protect");
const temperature_sensor_1 = require("./accessories/temperature-sensor");
const thermostat_1 = require("./accessories/thermostat");
/**
 * Resolved once via `require` rather than a static `import`: `package.json`
 * lives outside the TypeScript `rootDir` (`src/`), so importing it would alter
 * the emitted `dist/` layout.
 */
function readPluginVersion() {
    try {
        return require('../package.json').version || 'unknown';
    }
    catch {
        return 'unknown';
    }
}
const PLUGIN_VERSION = readPluginVersion();
/**
 * How long to gather updates before pushing them to HomeKit.
 *
 * A single Observe reconnect delivers a full snapshot as dozens of frames in
 * quick succession. Rebuilding the inventory per frame would do the same work
 * dozens of times for one logical update; a short window collapses that into
 * one pass while staying far below the point a person would notice.
 */
const UPDATE_COALESCE_MS = 250;
/**
 * How often to repeat the "authentication is still failing" line.
 *
 * A fatal stops both transports and every other periodic log, so this is the
 * only remaining signal that HomeKit's values are frozen.
 */
const FATAL_REMINDER_MS = 60 * 60_000;
/**
 * Concurrent Nest writes allowed when setting Eco across the whole house.
 *
 * Unbounded fan-out sent one BatchUpdateState POST per thermostat at once, with
 * no breaker in front of them; a single 429 or WAF 403 from that burst fails
 * the batch and the user retries, feeding the loop.
 */
const ECO_WRITE_CONCURRENCY = 2;
/** Whether a redacted structured-log line is still valid JSON. */
function isParseableJson(value) {
    try {
        JSON.parse(value);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Whether a startup failure is genuinely unrecoverable without user action.
 *
 * Only a rejected credential or a config/contract problem qualifies. Everything
 * else — DNS, TLS, timeouts, 5xx, an open breaker — is a transient condition the
 * run loops already recover from, so the boot path must retry rather than give
 * up and blame the token.
 */
function isFatalStartupError(error) {
    return error instanceof errors_1.AuthenticationError
        || error instanceof errors_1.ConfigurationError
        || error instanceof errors_1.SessionShapeError;
}
class MyNestPlatform {
    Service;
    Characteristic;
    api;
    #log;
    #rawLog;
    #config = null;
    #diagnostics = null;
    /** Restored and newly registered accessories, keyed by HAP UUID. */
    #cachedAccessories = new Map();
    /** Live accessory handlers, keyed by device id. */
    #handlers = new Map();
    /** Optional house-wide Eco switch (not a Nest device). */
    #globalEco = null;
    #observe = new observe_state_1.ObserveState((cap) => {
        this.#log.warn(`Observe is tracking ${cap} resources — further ones are being dropped. `
            + 'Nest may be emitting identifiers this plugin does not model.');
    });
    #buckets = {};
    #transport = null;
    #pendingUpdate = null;
    #pendingChangedIds = null;
    #bucketsChanged = false;
    #isShuttingDown = false;
    #hasFatal = false;
    #startedAt = 0;
    /**
     * Device resource ids seen during the current Observe reconnect burst.
     * `null` means we are not collecting (steady-state patches only).
     */
    #observeSnapshotIds = null;
    #observeSnapshotSettleTimer = null;
    /** Guards against a session that connects but never delivers a device. */
    #observeSnapshotAbandonTimer = null;
    /**
     * True after at least one non-truncated Observe device burst has settled.
     * HomeKit prune must wait for this — early frames increment `observeFrames`
     * before thermostats land, and pruning then bounces every Observe-only tile.
     */
    #hasSettledObserveSnapshot = false;
    /**
     * Observe `DEVICE_*` ids missing from a complete snapshot, and which snapshot
     * they were missing from.
     *
     * A device is removed only when two *consecutive* complete snapshots omit it,
     * so neither a truncated reconnect nor two unrelated absences weeks apart can
     * wipe part of the house. The value is the sequence number of the snapshot
     * that recorded the strike; a non-adjacent absence starts the count over.
     */
    #observeRemovalCandidates = new Map();
    /** Complete, non-truncated Observe snapshots seen this session. */
    #observeSnapshotSequence = 0;
    /**
     * Inventory from the most recent sync, reused by the diagnostics gauges.
     *
     * Keeps the reported per-kind counts consistent with the handlers the same
     * pass published, and avoids rebuilding the whole merged view — every trait
     * re-read, every thermostat's comfort source re-resolved — for a heartbeat.
     */
    #lastInventory = null;
    #diagnosticsTimer = null;
    #fatalReminderTimer = null;
    #startRetryTimer = null;
    #startRetryAttempt = 0;
    #lastDiagnosticsHealth = null;
    /** One-shot startup line after the first HomeKit inventory sync. */
    #hasLoggedPlatformReady = false;
    constructor(log, config, api) {
        this.api = api;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.#rawLog = log;
        const raw = config;
        this.#log = (0, logger_1.createScopedLogger)(log, settings_1.PLATFORM_NAME, raw.debug === true);
        try {
            const { config: resolved, warnings } = (0, validators_1.validateConfig)(raw);
            this.#config = resolved;
            this.#diagnostics = new collector_1.DiagnosticsCollector({
                pluginVersion: PLUGIN_VERSION,
                config: resolved,
            });
            for (const warning of warnings) {
                this.#log.warn(warning);
            }
        }
        catch (error) {
            // Homebridge keeps running other platforms, so this must not throw. The
            // plugin simply publishes nothing and says why.
            this.#log.error(error instanceof errors_1.ConfigurationError
                ? error.message
                : `Configuration is not usable: ${(0, sanitizers_1.sanitizeError)(error)}`);
        }
        // Never let a rejection escape: Homebridge invokes this listener with no
        // handler, and an unhandled rejection terminates the whole process under
        // Node's default `--unhandled-rejections=throw`.
        this.api.on('didFinishLaunching', () => {
            this.#start().catch((error) => {
                this.#log.error(`Could not start: ${(0, sanitizers_1.sanitizeError)(error)}`);
            });
        });
        this.api.on('shutdown', () => this.#stop());
    }
    get resolvedConfig() {
        if (!this.#config) {
            throw new errors_1.ConfigurationError('The platform is not configured');
        }
        return this.#config;
    }
    /** Homebridge replays cached accessories here before `didFinishLaunching`. */
    configureAccessory(accessory) {
        this.#log.debug(`Restoring ${accessory.displayName} from cache`);
        this.#cachedAccessories.set(accessory.UUID, accessory);
    }
    async #start() {
        if (!this.#config) {
            // Accessories are kept, for the same reason #handleFatal keeps them: a
            // typo, a half-edited config.json, or a truncated token would otherwise
            // destroy every room assignment, scene membership, and automation target
            // in the Home app — and fixing the config does not bring them back,
            // because HomeKit treats the re-registered accessories as new devices.
            // A config error is less severe than a revoked token, so it cannot
            // warrant a more destructive response.
            this.#log.error('Configuration is not usable — accessories were kept but will not update. '
                + 'Fix the configuration and restart Homebridge.');
            return;
        }
        this.#startedAt = Date.now();
        if (this.#config.allowThermostatControl) {
            this.#log.info('Thermostat control enabled (Nest BatchUpdateState).');
        }
        const diagnostics = this.#diagnostics;
        const transport = new transport_1.NestTransport({
            accessToken: this.#config.accessToken,
            endpoints: (0, settings_1.resolveEndpoints)(this.#config.fieldTest),
            log: this.#log,
            onTraits: (traits) => this.#applyTraits(traits),
            onBuckets: (buckets) => this.#applyBuckets(buckets),
            onObserveSessionStart: () => this.#beginObserveSnapshot(),
            onFatal: (error) => this.#handleFatal(error),
            onCircuitOpen: () => diagnostics?.breakerTrip(),
            onRestAlarmFeedChange: () => {
                // Force every Protect to re-evaluate smoke/CO from feed availability.
                this.#bucketsChanged = true;
                this.#scheduleUpdate();
            },
            statusHeartbeatEnabled: this.#config.diagnosticsInterval <= 0,
            metrics: diagnostics
                ? {
                    apiRequest: (ms, ok, options) => diagnostics.apiRequest(ms, ok, options),
                    sessionLogin: () => diagnostics.sessionLogin(),
                    restCycle: (ok, ms) => diagnostics.restCycle(ok, ms),
                    observeReconnect: () => diagnostics.observeReconnect(),
                    retry: () => diagnostics.retry(),
                }
                : undefined,
        });
        this.#transport = transport;
        try {
            await transport.start();
        }
        catch (error) {
            // Only an unrecoverable failure may reach #handleFatal. `start()` opens a
            // session and runs one app_launch, so it also rejects for DNS, TLS,
            // timeout, 5xx, and breaker errors — none of which mean the token is bad.
            // Treating those as fatal permanently disabled the plugin for the life of
            // the process and told the user to paste a fresh token, which is exactly
            // what a Raspberry Pi that boots before its network is up would see.
            // Steady state already classifies these correctly; this is the boot path
            // catching up.
            if (isFatalStartupError(error)) {
                this.#handleFatal(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            this.#log.warn(`Could not reach Nest at startup (${(0, sanitizers_1.sanitizeError)(error)}); retrying in the background.`);
            this.#scheduleStartRetry();
            return;
        }
        this.#startRetryAttempt = 0;
        this.#startDiagnostics();
        // REST is up; Observe usually follows within a second. Naming both avoids
        // implying thermostats are already live when only app_launch succeeded.
        this.#log.info('Connected to Nest (REST up; Observe connecting)');
    }
    /**
     * Retry `#start` with backoff after a transient startup failure.
     *
     * `didFinishLaunching` fires once, so without this a single blip at boot left
     * the plugin permanently idle — and cache-restored Protect tiles keep whatever
     * smoke/CO value Homebridge persisted, with no handler to mark them faulted.
     */
    #scheduleStartRetry() {
        if (this.#isShuttingDown || this.#hasFatal || this.#startRetryTimer) {
            return;
        }
        this.#transport?.stop();
        this.#transport = null;
        this.#startRetryAttempt++;
        const delayMs = (0, retry_1.computeBackoffMs)(this.#startRetryAttempt);
        this.#startRetryTimer = setTimeout(() => {
            this.#startRetryTimer = null;
            if (this.#isShuttingDown || this.#hasFatal) {
                return;
            }
            void this.#start().catch((error) => {
                this.#log.error(`Startup retry failed: ${(0, sanitizers_1.sanitizeError)(error)}`);
            });
        }, delayMs);
        this.#startRetryTimer.unref?.();
    }
    #stop() {
        this.#isShuttingDown = true;
        if (this.#diagnosticsTimer) {
            try {
                if (this.#diagnostics) {
                    this.#emitDiagnostic('info', this.#diagnostics.snapshot('diagnostics.stop', this.#buildDiagnosticsReaders()));
                }
            }
            catch (error) {
                this.#log.debug(`Failed to emit diagnostics stop snapshot: ${(0, sanitizers_1.sanitizeError)(error)}`);
            }
            clearInterval(this.#diagnosticsTimer);
            this.#diagnosticsTimer = null;
        }
        if (this.#fatalReminderTimer) {
            clearInterval(this.#fatalReminderTimer);
            this.#fatalReminderTimer = null;
        }
        if (this.#startRetryTimer) {
            clearTimeout(this.#startRetryTimer);
            this.#startRetryTimer = null;
        }
        if (this.#pendingUpdate) {
            clearTimeout(this.#pendingUpdate);
            this.#pendingUpdate = null;
        }
        this.#clearObserveSnapshotTimers();
        this.#observeSnapshotIds = null;
        this.#observeRemovalCandidates.clear();
        this.#globalEco?.dispose();
        this.#transport?.stop();
        this.#transport = null;
    }
    /**
     * A failure nothing can recover from without a config change — almost always
     * an expired or revoked Nest Account access token.
     *
     * Homebridge has no way for a plugin to unload itself, so the transports are
     * stopped and the reason is logged once. Retrying a token Nest has refused
     * only produces the same refusal every few seconds.
     *
     * Accessories stay in HomeKit: Nest auth is a pasted session token that the
     * user must refresh manually, and tearing down rooms/automations for that
     * would be worse than showing last-known values until they restart with a
     * fresh token.
     */
    #handleFatal(error) {
        if (this.#hasFatal) {
            return;
        }
        this.#hasFatal = true;
        this.#log.error(`${error.message} Paste a fresh token from https://home.nest.com/session and restart. Accessories were kept.`);
        // Mark Protect smoke/CO inactive/faulted while handlers can still refresh.
        // `#stop` sets `#isShuttingDown` and drops `#scheduleUpdate`, so the
        // transport's onRestAlarmFeedChange callback would not reach HomeKit.
        try {
            this.#syncAccessories({
                changedIds: null,
                bucketsChanged: true,
                restAlarmFeedAvailable: false,
            });
        }
        catch (syncError) {
            this.#log.debug(`Could not mark Protect alarm feeds stale after auth failure: ${(0, sanitizers_1.sanitizeError)(syncError)}`);
        }
        this.#stop();
        // Armed after #stop(), which clears it — that is what makes a real
        // Homebridge shutdown cancel the reminder. #stop() has just torn down the
        // transport heartbeat and the diagnostics timer, so without this the plugin
        // emits nothing ever again while HomeKit keeps serving frozen readings, and
        // the single error line above scrolls out of the log within hours.
        this.#fatalReminderTimer = setInterval(() => {
            this.#log.error('Nest authentication is still failing — readings are frozen. '
                + 'Paste a fresh token from https://home.nest.com/session and restart Homebridge.');
        }, FATAL_REMINDER_MS);
        this.#fatalReminderTimer.unref?.();
    }
    #applyTraits(traits) {
        const changed = this.#observe.apply(traits);
        this.#pendingChangedIds ??= new Set();
        for (const resourceId of changed) {
            // Observe keys resources as DEVICE_…; accessories are keyed by bare id.
            this.#pendingChangedIds.add((0, classify_1.toDeviceId)(resourceId));
        }
        if (this.#observeSnapshotIds) {
            for (const update of traits) {
                if (update.resourceId.startsWith(classify_1.OBSERVE_DEVICE_PREFIX)) {
                    this.#observeSnapshotIds.add(update.resourceId);
                }
            }
            this.#armObserveSnapshotSettle();
        }
        this.#scheduleUpdate();
    }
    /**
     * Start collecting the device set Nest sends on a fresh Observe connection.
     *
     * Two separate deadlines, because they answer different questions. The
     * *abandon* deadline covers "did this session ever deliver anything?" and has
     * to be long enough to absorb a TCP + TLS handshake plus gateway processing —
     * arming the short quiet-period timer here instead meant a merely slow
     * connection finalized an empty snapshot, which nulled the collector, stopped
     * re-arming, and left `#hasSettledObserveSnapshot` false so HomeKit pruning
     * never ran again for that session. The *settle* deadline is the quiet period
     * after the last trait, and only `#applyTraits` may arm it.
     */
    #beginObserveSnapshot() {
        if (this.#isShuttingDown) {
            return;
        }
        this.#observeSnapshotIds = new Set();
        this.#clearObserveSnapshotTimers();
        this.#observeSnapshotAbandonTimer = setTimeout(() => {
            this.#observeSnapshotAbandonTimer = null;
            if (this.#observeSnapshotIds?.size === 0) {
                // Nothing arrived at all; stop collecting so a trait-less session
                // cannot leave the collector open forever and block pruning.
                this.#observeSnapshotIds = null;
                this.#log.debug('Observe session produced no devices before the snapshot deadline');
            }
        }, settings_1.OBSERVE_SNAPSHOT_ABANDON_MS);
        this.#observeSnapshotAbandonTimer.unref?.();
    }
    #clearObserveSnapshotTimers() {
        if (this.#observeSnapshotSettleTimer) {
            clearTimeout(this.#observeSnapshotSettleTimer);
            this.#observeSnapshotSettleTimer = null;
        }
        if (this.#observeSnapshotAbandonTimer) {
            clearTimeout(this.#observeSnapshotAbandonTimer);
            this.#observeSnapshotAbandonTimer = null;
        }
    }
    /** After the opening burst goes quiet, drop Observe devices Nest omitted. */
    #armObserveSnapshotSettle() {
        if (this.#observeSnapshotSettleTimer) {
            clearTimeout(this.#observeSnapshotSettleTimer);
        }
        // The burst has started, so the "never delivered anything" guard is moot.
        if (this.#observeSnapshotAbandonTimer) {
            clearTimeout(this.#observeSnapshotAbandonTimer);
            this.#observeSnapshotAbandonTimer = null;
        }
        this.#observeSnapshotSettleTimer = setTimeout(() => {
            this.#observeSnapshotSettleTimer = null;
            this.#finalizeObserveSnapshot();
        }, settings_1.OBSERVE_SNAPSHOT_SETTLE_MS);
        this.#observeSnapshotSettleTimer.unref?.();
    }
    #finalizeObserveSnapshot() {
        const snapshotIds = this.#observeSnapshotIds;
        this.#observeSnapshotIds = null;
        if (!snapshotIds || this.#isShuttingDown) {
            return;
        }
        // An empty or drastically smaller burst is usually a truncated reconnect,
        // not a home that lost half its devices at once. Do not update removal
        // candidates from an incomplete inventory.
        const previousCount = this.#observe.deviceResourceCount;
        if (snapshotIds.size === 0) {
            return;
        }
        if (previousCount > 0 && snapshotIds.size * 2 < previousCount) {
            // Still clear candidates for devices Nest did name — a truncated burst
            // must not leave a present device one strike from deletion.
            for (const id of snapshotIds) {
                this.#observeRemovalCandidates.delete(id);
            }
            this.#log.warn(`Observe reconnect incomplete (${snapshotIds.size} devices, had ${previousCount}) — keeping prior state`);
            return;
        }
        // A non-empty, non-truncated burst is enough to allow HomeKit prune — even
        // when Nest named zero removals this round.
        this.#hasSettledObserveSnapshot = true;
        this.#observeSnapshotSequence++;
        const knownDeviceIds = this.#observe.resourceIds
            .filter((id) => id.startsWith(classify_1.OBSERVE_DEVICE_PREFIX));
        const missing = knownDeviceIds.filter((id) => !snapshotIds.has(id));
        for (const id of snapshotIds) {
            this.#observeRemovalCandidates.delete(id);
        }
        const toRemove = new Set();
        for (const id of missing) {
            // The two strikes have to be *consecutive*. Recording only "has a strike"
            // meant a device legitimately absent from one snapshot on Monday and
            // another on Friday was removed, despite appearing in every snapshot in
            // between — because a strike was only cleared when that specific id
            // showed up in a complete snapshot. Comparing sequence numbers makes a
            // gap reset the count.
            const struckAt = this.#observeRemovalCandidates.get(id);
            if (struckAt === this.#observeSnapshotSequence - 1) {
                toRemove.add(id);
                this.#observeRemovalCandidates.delete(id);
            }
            else {
                this.#observeRemovalCandidates.set(id, this.#observeSnapshotSequence);
            }
        }
        if (toRemove.size > 0) {
            const live = new Set(knownDeviceIds.filter((id) => !toRemove.has(id)));
            const removed = this.#observe.retainDeviceResources(live);
            if (removed.length > 0) {
                this.#log.info(`Observe dropped ${removed.length} device(s) — removing from HomeKit`);
            }
        }
        // Always sync after a settled burst so HomeKit prune (gated on
        // `#hasSettledObserveSnapshot`) can drop cached ghosts even when Nest
        // removed nothing from Observe state this round.
        this.#bucketsChanged = true;
        this.#scheduleUpdate();
    }
    #applyBuckets(buckets) {
        this.#buckets = buckets;
        this.#bucketsChanged = true;
        this.#scheduleUpdate();
    }
    /** Collapse a burst of transport updates into one HomeKit refresh. */
    #scheduleUpdate() {
        if (this.#pendingUpdate || this.#isShuttingDown) {
            return;
        }
        this.#pendingUpdate = setTimeout(() => {
            this.#pendingUpdate = null;
            try {
                const changedIds = this.#pendingChangedIds;
                const bucketsChanged = this.#bucketsChanged;
                this.#pendingChangedIds = null;
                this.#bucketsChanged = false;
                this.#syncAccessories({ changedIds, bucketsChanged });
            }
            catch (error) {
                this.#log.error(`Could not apply a Nest update: ${(0, sanitizers_1.sanitizeError)(error)}`);
            }
        }, UPDATE_COALESCE_MS);
        this.#pendingUpdate.unref?.();
    }
    /** Rebuild the merged inventory and reconcile it with what HomeKit shows. */
    #syncAccessories(options) {
        if (!this.#config) {
            return;
        }
        // Nothing to do — checked before building the inventory, which re-reads
        // every trait and re-resolves every thermostat's comfort source.
        if (!options.bucketsChanged && options.changedIds && options.changedIds.size === 0) {
            return;
        }
        const inventory = (0, registry_1.buildInventory)({
            observe: this.#observe,
            buckets: this.#buckets,
            ignoredDeviceIds: this.#config.ignoredDeviceIds,
            restAlarmFeedAvailable: options.restAlarmFeedAvailable
                ?? this.#transport?.status.isRestAlarmFeedAvailable
                ?? false,
        });
        this.#lastInventory = inventory;
        // A reconnect snapshot names every device; a typical patch names one.
        // Refresh only the affected accessories unless REST buckets changed (which
        // can add/remove devices) or the change set is large.
        const devices = (0, registry_1.listDevices)(inventory);
        const refreshAll = options.bucketsChanged
            || !options.changedIds
            || options.changedIds.size >= Math.max(8, Math.ceil(devices.length / 2));
        let pushedUpdates = 0;
        for (const device of devices) {
            const handler = this.#handlers.get(device.identity.id);
            if (handler) {
                if (refreshAll || options.changedIds?.has(device.identity.id)) {
                    handler.update(device);
                    pushedUpdates++;
                }
            }
            else {
                this.#publish(device);
                pushedUpdates++;
            }
        }
        if (pushedUpdates > 0) {
            this.#diagnostics?.externalChange();
        }
        this.#removeStaleAccessories(inventory);
        this.#syncGlobalEco(inventory);
        if (!this.#hasLoggedPlatformReady) {
            this.#hasLoggedPlatformReady = true;
            this.#log.info('Platform ready');
        }
    }
    // Observe trait maps are dropped only by `#finalizeObserveSnapshot`, on the
    // two-strike evidence that Nest stopped reporting a device.
    //
    // Absence from `inventory` is deliberately *not* treated as that evidence.
    // Three kinds of resource are missing from inventory while Nest is still
    // streaming them: a device whose classifying trait has not arrived yet
    // (`classifyResource` needs a Protect/HVAC/temperature type, which can land
    // frames after `device_identity`), an unsupported product such as a camera or
    // lock, and a device the user put in `ignoredDeviceIds`. Pruning on inventory
    // absence discarded identity traits from earlier frames — so the device was
    // later republished unnamed and with no model or serial — and wiped the
    // Temperature Sensor state that `readComfortTemperatures` reads, which made a
    // thermostat's reported temperature flap between its paired sensor and its
    // own backplate.
    /** Create or adopt the HomeKit accessory for a device seen for the first time. */
    #publish(device) {
        const uuid = this.api.hap.uuid.generate(`${settings_1.UUID_PREFIX}${device.identity.id}`);
        const category = this.#categoryFor(device.identity.kind);
        const context = {
            deviceId: device.identity.id,
            kind: device.identity.kind,
            displayName: device.identity.name,
        };
        const cached = this.#cachedAccessories.get(uuid);
        let accessory;
        if (cached) {
            accessory = cached;
            accessory.context = context;
            accessory.displayName = device.identity.name;
            accessory.category = category;
            this.api.updatePlatformAccessories([accessory]);
        }
        else {
            // Category is required at register time on Homebridge 2 for room tiles.
            accessory = new this.api.platformAccessory(device.identity.name, uuid, category);
            accessory.category = category;
            accessory.context = context;
            this.#cachedAccessories.set(uuid, accessory);
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            const via = device.identity.sources.observe && device.identity.sources.rest
                ? 'Observe and REST'
                : device.identity.sources.observe
                    ? 'Observe only'
                    : 'REST only';
            // The id is here because config.schema.json points at this line as the way
            // to find a value for ignoredDeviceIds; there is no other route to it.
            this.#log.info(`Added ${device.identity.kind} "${device.identity.name}" `
                + `[${device.identity.id}] (via ${via})`);
        }
        const log = (0, logger_1.createScopedLogger)(this.#rawLog, device.identity.name, this.#config?.debug === true);
        this.#handlers.set(device.identity.id, this.#createHandler(accessory, device, log));
    }
    /** HAP accessory category so Home shows room tiles (required on Homebridge 2). */
    #categoryFor(kind) {
        const { Categories } = this.api.hap;
        switch (kind) {
            case 'thermostat':
                return 9 /* Categories.THERMOSTAT */;
            case 'protect':
            case 'temperature_sensor':
                return 10 /* Categories.SENSOR */;
            default: {
                const exhaustive = kind;
                return exhaustive;
            }
        }
    }
    #createHandler(accessory, device, log) {
        if ((0, device_1.isDeviceOfKind)(device, 'thermostat')) {
            return new thermostat_1.ThermostatAccessory(this, accessory, device, log);
        }
        if ((0, device_1.isDeviceOfKind)(device, 'protect')) {
            return new protect_1.ProtectAccessory(this, accessory, device, log);
        }
        return new temperature_sensor_1.TemperatureSensorAccessory(this, accessory, device, log);
    }
    /**
     * Apply a HomeKit-originated thermostat change via Nest BatchUpdateState.
     *
     * No-ops when control is disabled so characteristics can stay writable for
     * HomeKit presentation without guessing at HVAC writes. The accessory logs
     * the user-facing success / ignore line.
     *
     * @returns The write that was sent, or `null` when control is off.
     */
    async applyThermostatWrite(deviceId, state, patch) {
        if (!this.#config?.allowThermostatControl) {
            return null;
        }
        const transport = this.#transport;
        if (!transport) {
            throw new errors_1.ConfigurationError('Nest transport is not running');
        }
        const write = (0, thermostat_write_1.buildThermostatSetpointWrite)((0, classify_1.toResourceId)(deviceId), state, patch);
        await transport.updateThermostatSettings(write);
        return write;
    }
    /**
     * Set Eco on one thermostat via Nest BatchUpdateState.
     *
     * @returns `true` when a Nest write was sent; `false` when control is off.
     */
    async applyEcoWrite(deviceId, ecoOn) {
        if (!this.#config?.allowThermostatControl) {
            return false;
        }
        const transport = this.#transport;
        if (!transport) {
            throw new errors_1.ConfigurationError('Nest transport is not running');
        }
        await transport.updateEcoMode((0, classify_1.toResourceId)(deviceId), ecoOn);
        return true;
    }
    /**
     * Set Eco on every published Nest thermostat.
     *
     * @returns `true` only when every targeted thermostat accepted the write.
     *   `false` when control is off, there are no thermostats, or any write failed
     *   (partial failures are logged; HomeKit must not flip the global switch).
     */
    async applyGlobalEcoWrite(ecoOn) {
        if (!this.#config?.allowThermostatControl) {
            return false;
        }
        const transport = this.#transport;
        if (!transport) {
            throw new errors_1.ConfigurationError('Nest transport is not running');
        }
        // Live handlers only — cached ghosts awaiting prune must not fail the batch.
        // `context` is optional-chained because Homebridge assigns it verbatim from
        // the persisted cache, so an accessory stored without one restores with
        // `undefined` and would otherwise throw here and fail every Eco press.
        const deviceIds = [...this.#cachedAccessories.values()]
            .map((accessory) => accessory.context)
            .filter((context) => (context?.kind === 'thermostat'
            && context.synthetic !== 'global_eco'
            && this.#handlers.has(context.deviceId)))
            .map((context) => context.deviceId);
        if (deviceIds.length === 0) {
            this.#log.warn('Nest Eco Mode: no thermostats to update');
            return false;
        }
        // Bounded fan-out: these are unguarded writes to a private Nest gateway.
        const results = [];
        for (let index = 0; index < deviceIds.length; index += ECO_WRITE_CONCURRENCY) {
            const batch = deviceIds.slice(index, index + ECO_WRITE_CONCURRENCY);
            results.push(...await Promise.allSettled(batch.map(async (deviceId) => {
                await transport.updateEcoMode((0, classify_1.toResourceId)(deviceId), ecoOn);
            })));
        }
        let failed = 0;
        for (const [index, result] of results.entries()) {
            if (result.status === 'rejected') {
                failed++;
                this.#log.warn(`Nest Eco Mode: ${deviceIds[index]} failed: ${(0, sanitizers_1.sanitizeError)(result.reason)}`);
            }
        }
        if (failed > 0) {
            if (failed === results.length) {
                throw new Error(`Eco update failed on all ${failed} thermostat(s)`);
            }
            this.#log.warn(`Nest Eco Mode: ${failed}/${results.length} thermostat(s) failed — HomeKit left unchanged`);
            return false;
        }
        return true;
    }
    /**
     * Drop accessories Nest no longer reports — never because a transport is down.
     *
     * Observe is required before any HomeKit unregister: typical thermostats are
     * Observe-only, and pruning against a REST-only inventory on an Observe outage
     * (including a slow boot) would bounce rooms and automations. REST-only
     * devices leave inventory via the transport's two-strike `app_launch` guard;
     * Observe-only devices leave via the two-strike reconnect snapshot prune.
     * The union inventory then makes them absent here.
     */
    #removeStaleAccessories(inventory) {
        const status = this.#transport?.status;
        if (!status) {
            return;
        }
        // No Nest inventory at all yet — keep the Homebridge cache untouched.
        if (status.observeFrames === 0 && status.knownObjects === 0) {
            return;
        }
        // Until Observe has named devices at least once this session, do not
        // unregister. A REST-only view cannot prove an Observe-only thermostat is
        // gone; keeping a ghost through an outage beats deleting a live room tile.
        if (status.observeFrames === 0) {
            return;
        }
        // Opening (or reconnect) burst still landing — union inventory is partial.
        if (this.#observeSnapshotIds !== null || !this.#hasSettledObserveSnapshot) {
            return;
        }
        const known = new Set((0, registry_1.listDevices)(inventory).map((device) => device.identity.id));
        for (const deviceId of [...this.#handlers.keys()]) {
            if (!known.has(deviceId)) {
                this.#handlers.delete(deviceId);
            }
        }
        for (const [uuid, accessory] of this.#cachedAccessories) {
            const context = accessory.context;
            if (context?.synthetic === 'global_eco') {
                continue;
            }
            if (context?.deviceId && known.has(context.deviceId)) {
                continue;
            }
            this.#log.info(`Removing ${accessory.displayName} — Nest no longer reports it`);
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            this.#cachedAccessories.delete(uuid);
        }
    }
    /**
     * Publish or refresh the optional house-wide Eco switch.
     *
     * On when every Nest thermostat is in Eco; Off otherwise. Turning it on/off
     * writes Eco to each thermostat (requires `allowThermostatControl`).
     */
    #syncGlobalEco(inventory) {
        if (!this.#config?.exposeGlobalEcoSwitch) {
            this.#removeGlobalEco();
            return;
        }
        const thermostats = (0, registry_1.listDevices)(inventory).filter((device) => (0, device_1.isDeviceOfKind)(device, 'thermostat'));
        const allEco = thermostats.length > 0
            && thermostats.every((device) => device.state.isEcoActive === true);
        if (!this.#globalEco) {
            this.#publishGlobalEco();
        }
        this.#globalEco?.updateAllEco(allEco);
    }
    #publishGlobalEco() {
        const uuid = this.api.hap.uuid.generate(`${settings_1.UUID_PREFIX}${settings_1.GLOBAL_ECO_DEVICE_ID}`);
        const category = 8 /* this.api.hap.Categories.SWITCH */;
        const displayName = settings_1.GLOBAL_ECO_DISPLAY_NAME;
        const context = {
            deviceId: settings_1.GLOBAL_ECO_DEVICE_ID,
            kind: 'thermostat',
            displayName,
            synthetic: 'global_eco',
        };
        let accessory = this.#cachedAccessories.get(uuid);
        if (!accessory) {
            accessory = new this.api.platformAccessory(displayName, uuid, category);
            accessory.category = category;
            accessory.context = context;
            this.#cachedAccessories.set(uuid, accessory);
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            this.#log.info(`Added ${displayName} (controls Eco on all thermostats)`);
        }
        else {
            accessory.context = context;
            accessory.displayName = displayName;
            accessory.category = category;
            this.api.updatePlatformAccessories([accessory]);
        }
        const log = (0, logger_1.createScopedLogger)(this.#rawLog, displayName, this.#config?.debug === true);
        this.#globalEco = new global_eco_1.GlobalEcoAccessory(this, accessory, log);
    }
    #removeGlobalEco() {
        const uuid = this.api.hap.uuid.generate(`${settings_1.UUID_PREFIX}${settings_1.GLOBAL_ECO_DEVICE_ID}`);
        const accessory = this.#cachedAccessories.get(uuid);
        if (accessory) {
            this.#log.info(`Removing ${accessory.displayName} — global Eco switch disabled in config`);
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            this.#cachedAccessories.delete(uuid);
        }
        this.#globalEco?.dispose();
        this.#globalEco = null;
    }
    #diagnosticsIntervalMs() {
        const seconds = this.#config?.diagnosticsInterval ?? 0;
        return seconds > 0 ? seconds * 1_000 : 0;
    }
    /**
     * Starts the diagnostics subsystem: emits the boot snapshot and schedules the
     * heartbeat. No-op unless diagnosticsInterval > 0.
     */
    #startDiagnostics() {
        const interval = this.#diagnosticsIntervalMs();
        if (interval <= 0 || this.#isShuttingDown || this.#diagnosticsTimer || !this.#diagnostics) {
            return;
        }
        try {
            const startReport = this.#diagnostics.snapshot('diagnostics.start', this.#buildDiagnosticsReaders());
            this.#lastDiagnosticsHealth = startReport.lifecycle.health;
            this.#emitDiagnostic('info', startReport);
        }
        catch (error) {
            this.#log.debug(`Failed to emit diagnostics start snapshot: ${(0, sanitizers_1.sanitizeError)(error)}`);
        }
        this.#diagnosticsTimer = setInterval(() => this.#diagnosticsHeartbeat(), interval);
        this.#diagnosticsTimer.unref?.();
    }
    #diagnosticsHeartbeat() {
        if (!this.#diagnostics) {
            return;
        }
        try {
            const report = this.#diagnostics.buildHeartbeat(this.#buildDiagnosticsReaders());
            this.#emitDiagnostic('info', report);
            const health = report.lifecycle.health;
            if (this.#lastDiagnosticsHealth !== null && health !== this.#lastDiagnosticsHealth) {
                const isDegraded = health === 'degraded';
                const transition = {
                    ...report,
                    msg: isDegraded ? 'health.degraded' : 'health.recovered',
                };
                this.#emitDiagnostic(isDegraded ? 'warn' : 'info', transition);
            }
            this.#lastDiagnosticsHealth = health;
        }
        catch (error) {
            this.#log.debug(`Diagnostics heartbeat failed: ${(0, sanitizers_1.sanitizeError)(error)}`);
        }
    }
    #buildDiagnosticsReaders() {
        return {
            transport: () => {
                const status = this.#transport?.status;
                if (!status) {
                    return {
                        hasSession: false,
                        observeState: 'stopped',
                        restState: 'stopped',
                        observeFrames: 0,
                        restCycles: 0,
                        knownObjects: 0,
                        lastObserveFrameAgeSec: null,
                        lastRestSuccessAgeSec: null,
                        isRestAlarmFeedAvailable: false,
                        isDecodeDegraded: false,
                        circuitBreaker: { rest: 'CLOSED', observe: 'CLOSED' },
                    };
                }
                return {
                    hasSession: status.hasSession,
                    observeState: status.observeState,
                    restState: status.restState,
                    observeFrames: status.observeFrames,
                    restCycles: status.restCycles,
                    knownObjects: status.knownObjects,
                    lastObserveFrameAgeSec: status.lastObserveFrameAgeSec,
                    lastRestSuccessAgeSec: status.lastRestSuccessAgeSec,
                    isRestAlarmFeedAvailable: status.isRestAlarmFeedAvailable,
                    isDecodeDegraded: status.isDecodeDegraded,
                    circuitBreaker: {
                        rest: status.circuitBreaker.rest.state,
                        observe: status.circuitBreaker.observe.state,
                    },
                };
            },
            devices: () => this.#collectDeviceGauges(),
            fatalActive: () => this.#hasFatal,
            uptimeSec: () => (this.#startedAt > 0 ? Math.round((Date.now() - this.#startedAt) / 1000) : 0),
        };
    }
    #collectDeviceGauges() {
        const byKind = { thermostat: 0, protect: 0, temperature_sensor: 0 };
        let observeOnly = 0;
        let restOnly = 0;
        let both = 0;
        // Every state change schedules a sync, so the cached inventory is current
        // whenever one exists; a fresh build is only needed before the first sync.
        const inventory = this.#lastInventory ?? (this.#config
            ? (0, registry_1.buildInventory)({
                observe: this.#observe,
                buckets: this.#buckets,
                ignoredDeviceIds: this.#config.ignoredDeviceIds,
                restAlarmFeedAvailable: this.#transport?.status.isRestAlarmFeedAvailable ?? false,
            })
            : null);
        if (inventory) {
            for (const device of (0, registry_1.listDevices)(inventory)) {
                byKind[device.identity.kind]++;
                const { observe, rest } = device.identity.sources;
                if (observe && rest) {
                    both++;
                }
                else if (observe) {
                    observeOnly++;
                }
                else if (rest) {
                    restOnly++;
                }
            }
        }
        return {
            total: this.#handlers.size,
            byKind,
            observeOnly,
            restOnly,
            both,
            ignored: this.#config?.ignoredDeviceIds.size ?? 0,
        };
    }
    /**
     * Emit a diagnostics report as a human-readable line.
     *
     * Homebridge's logger stringifies extra arguments onto the same line, so the
     * structured payload is either a separate JSON line (`structuredLogs`) or a
     * debug entry — matching sibling plugins.
     */
    #emitDiagnostic(level, report) {
        this.#log[level]((0, format_1.formatDiagnosticLine)(report));
        if (this.#config?.structuredLogs) {
            // The scoped logger runs the string through the redactor, whose header
            // rules match on substrings and would truncate the rest of the line. The
            // report carries no secrets, but "machine-readable" has to mean it: fall
            // back rather than ship a log pipeline something that will not parse.
            const line = JSON.stringify(report);
            const redacted = (0, sanitizers_1.sanitizeString)(line);
            if (isParseableJson(redacted)) {
                this.#log[level](redacted);
            }
            else {
                this.#log.debug('Diagnostics snapshot omitted: redaction made the JSON unparseable');
            }
            return;
        }
        const { lifecycle, msg, ...groups } = report;
        this.#log.debug('Diagnostics snapshot', {
            msg,
            ...groups,
            ...lifecycle,
        });
    }
}
exports.MyNestPlatform = MyNestPlatform;
