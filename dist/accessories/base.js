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
        this.binder = new bound_characteristics_1.CharacteristicBinder(log);
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
        this.identity = device.identity;
        this.state = device.state;
        this.#applyAccessoryInformation();
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
    /** Info on a change, debug otherwise, so the log follows the house. */
    #logSummary() {
        const summary = this.describeState();
        if (this.#lastSummary === null || this.#lastSummary === summary) {
            this.log.debug(`${this.identity.name}: ${summary}`);
        }
        else {
            this.log.info(`${this.identity.name}: ${summary}`);
        }
        this.#lastSummary = summary;
    }
}
exports.NestAccessory = NestAccessory;
//# sourceMappingURL=base.js.map