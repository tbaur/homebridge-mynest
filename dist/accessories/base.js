"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared behaviour for every accessory this plugin publishes.
 *
 * All three device types work the same way: bind each characteristic to a
 * function that reads current device state, then push everything at once when
 * new state arrives. Binding once and recomputing is what keeps live updates
 * working on Homebridge 2 — see `utils/bound-characteristics.ts` for why the
 * obvious alternatives silently stop updating.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NestAccessory = void 0;
const settings_1 = require("../settings");
const bound_characteristics_1 = require("../utils/bound-characteristics");
/** Whether any field published as Accessory Information differs. */
function hasIdentityChanged(previous, next) {
    return previous.name !== next.name
        || previous.model !== next.model
        || previous.serialNumber !== next.serialNumber
        || previous.firmwareVersion !== next.firmwareVersion
        || previous.id !== next.id;
}
/** One HomeKit accessory backed by one Nest device. */
class NestAccessory {
    platform;
    accessory;
    log;
    config;
    binder;
    identity;
    state;
    /** Last summary emitted, so an unchanged one stays at debug. */
    #lastSummary = null;
    constructor(platform, accessory, device, log) {
        this.platform = platform;
        this.accessory = accessory;
        this.log = log;
        this.config = platform.resolvedConfig;
        this.identity = device.identity;
        this.state = device.state;
        this.binder = new bound_characteristics_1.CharacteristicBinder(log, device.identity.name);
        this.#applyAccessoryInformation();
    }
    get deviceId() {
        return this.identity.id;
    }
    /**
     * Take new state and push it to HomeKit.
     *
     * Called on every merged update, which on a busy home is several times a
     * minute. HAP suppresses notifications for unchanged values, so pushing
     * unconditionally is cheaper than diffing here.
     */
    update(device) {
        const previousIdentity = this.identity;
        this.identity = device.identity;
        this.state = device.state;
        // Only when it actually changed. These four values essentially never do, and
        // re-applying them ran HAP's full value-validation path four times per
        // device per refresh on the hot update path.
        if (hasIdentityChanged(previousIdentity, device.identity)) {
            this.#applyAccessoryInformation();
        }
        this.onServicesMayChange();
        this.binder.refresh();
        this.#logSummary();
    }
    /**
     * Bind or remove optional services when Nest state becomes available later.
     *
     * Default is a no-op. Protect occupancy and thermostat humidity use this so
     * a device that starts Observe-only can grow services once REST catches up.
     */
    onServicesMayChange() {
        // Optional for subclasses.
    }
    /**
     * Find an existing service or create it.
     *
     * Accessories are restored from Homebridge's cache across restarts, so a
     * service is usually already there; adding a duplicate would publish the
     * device twice in the Home app.
     */
    resolveService(type) {
        const existing = this.accessory.getService(type);
        if (existing) {
            return existing;
        }
        return this.accessory.addService(type);
    }
    /**
     * Remove a service the user has turned off in config.
     *
     * Without this, disabling an option would leave a dead tile in the Home app
     * reporting whatever value it last held.
     */
    removeService(type) {
        const existing = this.accessory.getService(type);
        if (!existing) {
            return;
        }
        this.binder.unbindService(existing);
        this.accessory.removeService(existing);
    }
    /**
     * Map a low-battery verdict onto HomeKit's enum.
     *
     * `undefined` when Nest has said nothing, so the binder leaves the last known
     * value in place rather than publishing "normal" on no evidence.
     */
    toLowBatteryValue(isBatteryLow) {
        const { StatusLowBattery } = this.platform.Characteristic;
        if (isBatteryLow === undefined) {
            return undefined;
        }
        return isBatteryLow
            ? StatusLowBattery.BATTERY_LEVEL_LOW
            : StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }
    #applyAccessoryInformation() {
        const { Characteristic, Service: HapService } = this.platform;
        const service = this.accessory.getService(HapService.AccessoryInformation)
            ?? this.accessory.addService(HapService.AccessoryInformation);
        service
            .setCharacteristic(Characteristic.Manufacturer, settings_1.MANUFACTURER)
            .setCharacteristic(Characteristic.Name, this.identity.name)
            .setCharacteristic(Characteristic.Model, this.identity.model ?? 'Nest Device')
            .setCharacteristic(Characteristic.SerialNumber, this.identity.serialNumber ?? this.identity.id);
        if (this.identity.firmwareVersion) {
            service.setCharacteristic(Characteristic.FirmwareRevision, this.identity.firmwareVersion);
        }
    }
    /**
     * Info on a change, debug otherwise, so the log follows the house.
     *
     * The first summary is also info: it is the only default-visible confirmation
     * that a newly published device is actually reporting data. The "Added …"
     * line carries no readings, so folding the first summary into the debug
     * branch left an operator unable to tell a live device from a silent one.
     */
    #logSummary() {
        const summary = this.describeState();
        const isFirst = this.#lastSummary === null;
        if (!isFirst && this.#lastSummary === summary) {
            this.log.debug(`${this.identity.name}: ${summary}`);
        }
        else {
            this.log.info(`${this.identity.name}: ${summary}`);
        }
        this.#lastSummary = summary;
    }
}
exports.NestAccessory = NestAccessory;
