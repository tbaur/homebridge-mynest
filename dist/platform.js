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
const collector_1 = require("./diagnostics/collector");
const format_1 = require("./diagnostics/format");
const classify_1 = require("./state/classify");
const observe_state_1 = require("./state/observe-state");
const registry_1 = require("./state/registry");
const validators_1 = require("./utils/validators");
const logger_1 = require("./utils/logger");
const sanitizers_1 = require("./utils/sanitizers");
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
    #observe = new observe_state_1.ObserveState();
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
    /**
     * Observe `DEVICE_*` ids missing from the previous complete snapshot.
     * A device is removed only after a second consecutive complete snapshot omits it,
     * so a truncated reconnect cannot wipe half the house.
     */
    #observeRemovalCandidates = new Set();
    #diagnosticsTimer = null;
    #lastDiagnosticsHealth = null;
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
        this.api.on('didFinishLaunching', () => void this.#start());
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
            // Cached tiles from a previous good run would otherwise sit stale forever
            // with no handlers updating them.
            this.#unregisterAllCached('configuration is not usable');
            return;
        }
        this.#startedAt = Date.now();
        if (this.#config.allowThermostatControl) {
            this.#log.warn('Allow Thermostat Control ignored — thermostats are read-only in this version.');
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
            this.#handleFatal(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        this.#startDiagnostics();
        // REST is up; Observe usually follows within a second. Naming both avoids
        // implying thermostats are already live when only app_launch succeeded.
        this.#log.info('Connected to Nest (REST up; Observe connecting)');
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
        if (this.#pendingUpdate) {
            clearTimeout(this.#pendingUpdate);
            this.#pendingUpdate = null;
        }
        if (this.#observeSnapshotSettleTimer) {
            clearTimeout(this.#observeSnapshotSettleTimer);
            this.#observeSnapshotSettleTimer = null;
        }
        this.#observeSnapshotIds = null;
        this.#observeRemovalCandidates.clear();
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
                if (update.resourceId.startsWith('DEVICE_')) {
                    this.#observeSnapshotIds.add(update.resourceId);
                }
            }
            this.#armObserveSnapshotSettle();
        }
        this.#scheduleUpdate();
    }
    /** Start collecting the device set Nest sends on a fresh Observe connection. */
    #beginObserveSnapshot() {
        if (this.#isShuttingDown) {
            return;
        }
        this.#observeSnapshotIds = new Set();
        if (this.#observeSnapshotSettleTimer) {
            clearTimeout(this.#observeSnapshotSettleTimer);
            this.#observeSnapshotSettleTimer = null;
        }
    }
    /** After the opening burst goes quiet, drop Observe devices Nest omitted. */
    #armObserveSnapshotSettle() {
        if (this.#observeSnapshotSettleTimer) {
            clearTimeout(this.#observeSnapshotSettleTimer);
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
        const knownDeviceIds = this.#observe.resourceIds.filter((id) => id.startsWith('DEVICE_'));
        const missing = knownDeviceIds.filter((id) => !snapshotIds.has(id));
        for (const id of snapshotIds) {
            this.#observeRemovalCandidates.delete(id);
        }
        const toRemove = new Set();
        for (const id of missing) {
            if (this.#observeRemovalCandidates.has(id)) {
                toRemove.add(id);
                this.#observeRemovalCandidates.delete(id);
            }
            else {
                this.#observeRemovalCandidates.add(id);
            }
        }
        if (toRemove.size === 0) {
            return;
        }
        const live = new Set(knownDeviceIds.filter((id) => !toRemove.has(id)));
        const removed = this.#observe.retainDeviceResources(live);
        if (removed.length === 0) {
            return;
        }
        this.#log.info(`Observe dropped ${removed.length} device(s) — removing from HomeKit`);
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
        const inventory = (0, registry_1.buildInventory)({
            observe: this.#observe,
            buckets: this.#buckets,
            ignoredDeviceIds: this.#config.ignoredDeviceIds,
            restAlarmFeedAvailable: options.restAlarmFeedAvailable
                ?? this.#transport?.status.isRestAlarmFeedAvailable
                ?? false,
        });
        // A reconnect snapshot names every device; a typical patch names one.
        // Refresh only the affected accessories unless REST buckets changed (which
        // can add/remove devices) or the change set is large.
        const devices = (0, registry_1.listDevices)(inventory);
        if (!options.bucketsChanged && options.changedIds && options.changedIds.size === 0) {
            return;
        }
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
        this.#pruneStaleState(inventory);
        this.#removeStaleAccessories(inventory);
    }
    /** Drop Observe DEVICE_* maps and REST objects Nest no longer reports. */
    #pruneStaleState(inventory) {
        const liveDeviceIds = new Set((0, registry_1.listDevices)(inventory).map((device) => device.identity.id));
        const liveResourceIds = new Set([...liveDeviceIds].map((id) => (0, classify_1.toResourceId)(id)));
        this.#observe.retainDeviceResources(liveResourceIds);
    }
    /** Create or adopt the HomeKit accessory for a device seen for the first time. */
    #publish(device) {
        const uuid = this.api.hap.uuid.generate(`${settings_1.UUID_PREFIX}${device.identity.id}`);
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
            this.api.updatePlatformAccessories([accessory]);
        }
        else {
            accessory = new this.api.platformAccessory(device.identity.name, uuid);
            accessory.context = context;
            this.#cachedAccessories.set(uuid, accessory);
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            const via = device.identity.sources.observe && device.identity.sources.rest
                ? 'Observe and REST'
                : device.identity.sources.observe
                    ? 'Observe only'
                    : 'REST only';
            this.#log.info(`Added ${device.identity.kind} "${device.identity.name}" (via ${via})`);
        }
        const log = (0, logger_1.createScopedLogger)(this.#rawLog, device.identity.name, this.#config?.debug === true);
        this.#handlers.set(device.identity.id, this.#createHandler(accessory, device, log));
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
        const known = new Set((0, registry_1.listDevices)(inventory).map((device) => device.identity.id));
        for (const deviceId of [...this.#handlers.keys()]) {
            if (!known.has(deviceId)) {
                this.#handlers.delete(deviceId);
            }
        }
        for (const [uuid, accessory] of this.#cachedAccessories) {
            const context = accessory.context;
            if (context?.deviceId && known.has(context.deviceId)) {
                continue;
            }
            this.#log.info(`Removing ${accessory.displayName} — Nest no longer reports it`);
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            this.#cachedAccessories.delete(uuid);
        }
    }
    #unregisterAllCached(reason) {
        if (this.#cachedAccessories.size === 0) {
            return;
        }
        const accessories = [...this.#cachedAccessories.values()];
        this.#log.warn(`Unregistering ${accessories.length} cached accessory(ies) — ${reason}`);
        this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, accessories);
        this.#cachedAccessories.clear();
        this.#handlers.clear();
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
        if (this.#config) {
            const inventory = (0, registry_1.buildInventory)({
                observe: this.#observe,
                buckets: this.#buckets,
                ignoredDeviceIds: this.#config.ignoredDeviceIds,
                restAlarmFeedAvailable: this.#transport?.status.isRestAlarmFeedAvailable ?? false,
            });
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
            this.#log[level](JSON.stringify(report));
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
//# sourceMappingURL=platform.js.map