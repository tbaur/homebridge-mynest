"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest Protect as smoke, CO, and optional occupancy sensors.
 *
 * The occupancy sensor here is the part worth reading carefully. A Protect has
 * a PIR sensor, but neither Nest API publishes motion events: a 12.5-hour
 * capture of both transports on an occupied house recorded zero motion events
 * and zero occupancy changes. What is available is `auto_away`, Nest's own
 * verdict that nobody has been seen for roughly ten minutes, and only on
 * mains-powered units.
 *
 * So this accessory publishes occupancy only where that verdict exists, and
 * says why in the log when it does not. Presenting a ten-minute presence
 * signal as motion would be the easy thing to do and would make every
 * automation built on it wrong.
 *
 * Smoke and CO come from REST `topaz` only. Observe streams safety traits, but
 * no public schema maps them and every captured sample reads all-clear, so an
 * Observe-only Protect deliberately gets no smoke/CO tiles. When REST later
 * goes stale, tiles stay published (so HomeKit rooms/automations survive) but
 * are marked inactive/faulted — never a live frozen all-clear. See `docs/PROTOCOL.md`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProtectAccessory = void 0;
const settings_1 = require("../settings");
const protect_state_1 = require("../state/protect-state");
const base_1 = require("./base");
class ProtectAccessory extends base_1.NestAccessory {
    #smokeService = null;
    #coService = null;
    #didLogMissingAlarms = false;
    #didLogAlarmFeedStale = false;
    #didLogOccupancy = false;
    constructor(platform, accessory, device, log) {
        super(platform, accessory, device, log);
        this.bindCharacteristics();
        this.binder.refresh();
    }
    bindCharacteristics() {
        this.#ensureAlarmServices();
        this.#ensureBatteryService();
        this.#bindOccupancy();
        this.#bindTemperature();
    }
    onServicesMayChange() {
        this.#ensureAlarmServices();
        this.#ensureBatteryService();
        this.#bindOccupancy();
        this.#bindTemperature();
    }
    /**
     * Publish smoke and CO when REST has reported alarm state.
     *
     * HAP defaults SmokeDetected to "not detected". Creating the service before
     * Nest has said anything would show a working all-clear on no evidence.
     * Once created, services stay through REST outages (rooms/automations keep
     * their targets) and are marked inactive/faulted while the feed is stale.
     */
    #ensureAlarmServices() {
        const { Characteristic, Service: HapService } = this.platform;
        const hasAlarms = this.state.smoke !== undefined || this.state.carbonMonoxide !== undefined;
        if (!hasAlarms) {
            this.removeService(HapService.SmokeSensor);
            this.removeService(HapService.CarbonMonoxideSensor);
            this.#smokeService = null;
            this.#coService = null;
            if (!this.#didLogMissingAlarms) {
                this.#didLogMissingAlarms = true;
                this.log.info(`${this.identity.name}: no smoke/CO sensors — Nest has not reported alarm state over REST for this Protect (common for Observe-only units). Battery and online status may still appear.`);
            }
            return;
        }
        this.#didLogMissingAlarms = false;
        if (this.state.isAlarmFeedStale) {
            if (!this.#didLogAlarmFeedStale) {
                this.#didLogAlarmFeedStale = true;
                this.log.warn(`${this.identity.name}: Nest REST is not refreshing alarm state — smoke/CO kept in HomeKit but marked inactive until REST recovers.`);
            }
        }
        else if (this.#didLogAlarmFeedStale) {
            this.#didLogAlarmFeedStale = false;
            this.log.info(`${this.identity.name}: Nest REST alarm feed restored — smoke/CO are live again.`);
        }
        this.#smokeService = this.resolveService(HapService.SmokeSensor);
        this.#smokeService.setCharacteristic(Characteristic.Name, `${this.identity.name} Smoke`);
        this.#coService = this.resolveService(HapService.CarbonMonoxideSensor);
        this.#coService.setCharacteristic(Characteristic.Name, `${this.identity.name} CO`);
        this.binder.bind(this.#smokeService, Characteristic.SmokeDetected, () => this.#toSmokeValue(this.state.smoke));
        this.binder.bind(this.#coService, Characteristic.CarbonMonoxideDetected, () => this.#toCarbonMonoxideValue(this.state.carbonMonoxide));
        // Both services carry the shared health characteristics so either tile in
        // the Home app shows a flat battery, an offline device, or a stale REST feed.
        for (const service of [this.#smokeService, this.#coService]) {
            this.binder.bind(service, Characteristic.StatusLowBattery, () => this.#toLowBatteryValue());
            this.binder.bind(service, Characteristic.StatusActive, () => this.#isAlarmReadingLive());
            this.binder.bind(service, Characteristic.StatusFault, () => this.#isAlarmReadingLive()
                ? Characteristic.StatusFault.NO_FAULT
                : Characteristic.StatusFault.GENERAL_FAULT);
        }
        // Alarm tiles carry battery; the standalone Battery service is only for
        // Observe-only Protects that have no smoke/CO yet.
        this.removeService(HapService.Battery);
    }
    /** Alarm readings are live only while online and the REST feed is fresh. */
    #isAlarmReadingLive() {
        return this.state.isOnline !== false && this.state.isAlarmFeedStale !== true;
    }
    /**
     * Standalone battery for Protects that cannot publish smoke/CO yet.
     *
     * Observe still reports battery and liveness for Observe-only units, so the
     * accessory can appear in HomeKit without inventing alarm state.
     */
    #ensureBatteryService() {
        const { Characteristic, Service: HapService } = this.platform;
        const hasAlarms = this.state.smoke !== undefined || this.state.carbonMonoxide !== undefined;
        const hasBattery = this.state.isBatteryLow !== undefined || this.state.batteryVolts !== undefined;
        if (hasAlarms || !hasBattery) {
            this.removeService(HapService.Battery);
            return;
        }
        const battery = this.resolveService(HapService.Battery);
        battery.setCharacteristic(Characteristic.Name, `${this.identity.name} Battery`);
        battery.setCharacteristic(Characteristic.ChargingState, this.state.isLinePowered
            ? Characteristic.ChargingState.NOT_CHARGING
            : Characteristic.ChargingState.NOT_CHARGEABLE);
        this.binder.bind(battery, Characteristic.StatusLowBattery, () => this.#toLowBatteryValue());
        this.binder.bind(battery, Characteristic.BatteryLevel, () => this.#batteryLevelPercent());
    }
    /**
     * Publish occupancy only where Nest actually reports it.
     *
     * A device with no verdict gets no sensor at all rather than one stuck at
     * "not occupied", which would look like a working sensor reporting an empty
     * house forever.
     */
    #bindOccupancy() {
        const { Characteristic, Service: HapService } = this.platform;
        // Keep the service through REST outages when we still have a last verdict
        // (`unavailable_rest_stale` + isOccupied) so automations are not torn down.
        const isAvailable = this.config.exposeProtectOccupancy
            && this.state.isOccupied !== undefined
            && (this.state.occupancySource === 'auto_away'
                || this.state.occupancySource === 'unavailable_rest_stale');
        if (!isAvailable) {
            this.removeService(HapService.OccupancySensor);
            if (this.config.exposeProtectOccupancy) {
                this.log.debug(`${this.identity.name}: no occupancy sensor — ${(0, protect_state_1.describeOccupancySource)(this.state.occupancySource)}`);
            }
            return;
        }
        const service = this.resolveService(HapService.OccupancySensor);
        service.setCharacteristic(Characteristic.Name, `${this.identity.name} Occupancy`);
        this.binder.bind(service, Characteristic.OccupancyDetected, () => this.state.isOccupied === undefined
            ? undefined
            : this.state.isOccupied
                ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
                : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
        this.binder.bind(service, Characteristic.StatusActive, () => this.#isAlarmReadingLive());
        this.binder.bind(service, Characteristic.StatusFault, () => this.#isAlarmReadingLive()
            ? Characteristic.StatusFault.NO_FAULT
            : Characteristic.StatusFault.GENERAL_FAULT);
        if (!this.#didLogOccupancy) {
            this.#didLogOccupancy = true;
            this.log.info(`${this.identity.name}: occupancy is Nest's ${settings_1.PROTECT_OCCUPANCY_HOLD_OFF_SEC / 60}-minute presence verdict, not motion — it will not react instantly to someone walking past.`);
        }
    }
    /**
     * Publish the Protect's own temperature and humidity readings.
     *
     * Humidity gets its own service rather than riding along on the temperature
     * one: HomeKit defines the two separately, and adding the characteristic
     * where it does not belong makes HAP log a warning for every Protect in the
     * house at every startup.
     */
    #bindTemperature() {
        const { Characteristic, Service: HapService } = this.platform;
        if (!this.config.exposeProtectTemperature) {
            this.removeService(HapService.TemperatureSensor);
            this.removeService(HapService.HumiditySensor);
            return;
        }
        if (this.state.temperatureC === undefined) {
            this.removeService(HapService.TemperatureSensor);
        }
        else {
            const service = this.resolveService(HapService.TemperatureSensor);
            service.setCharacteristic(Characteristic.Name, `${this.identity.name} Temperature`);
            this.binder.bind(service, Characteristic.CurrentTemperature, () => this.state.temperatureC);
        }
        if (this.state.humidity === undefined) {
            this.removeService(HapService.HumiditySensor);
            return;
        }
        const humidity = this.resolveService(HapService.HumiditySensor);
        humidity.setCharacteristic(Characteristic.Name, `${this.identity.name} Humidity`);
        this.binder.bind(humidity, Characteristic.CurrentRelativeHumidity, () => this.state.humidity);
    }
    /**
     * Map Nest's three-level scale onto HomeKit's binary alarm.
     *
     * Nest's middle level is a "heads up" — enough smoke to mention, not enough
     * to sound the alarm. It is reported as detected anyway. On a life-safety
     * device, an alert the user did not need is a far better failure than a real
     * one HomeKit stayed quiet about.
     */
    #toSmokeValue(level) {
        const { Characteristic } = this.platform;
        if (level === undefined) {
            return undefined;
        }
        return level === 'ok'
            ? Characteristic.SmokeDetected.SMOKE_NOT_DETECTED
            : Characteristic.SmokeDetected.SMOKE_DETECTED;
    }
    #toCarbonMonoxideValue(level) {
        const { Characteristic } = this.platform;
        if (level === undefined) {
            return undefined;
        }
        return level === 'ok'
            ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL
            : Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL;
    }
    #toLowBatteryValue() {
        const { Characteristic } = this.platform;
        if (this.state.isBatteryLow === undefined) {
            return undefined;
        }
        return this.state.isBatteryLow
            ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }
    /**
     * HomeKit wants 0–100; Nest REST reports millivolts as `battery_level`.
     *
     * A healthy Protect is about 5.2 V. Without a published discharge curve this
     * is a coarse mapping: low battery → 10%, otherwise → 100%. Better than a
     * fabricated percentage pretending precision we do not have.
     */
    #batteryLevelPercent() {
        if (this.state.isBatteryLow === true) {
            return 10;
        }
        if (this.state.isBatteryLow === false) {
            return 100;
        }
        return undefined;
    }
    describeState() {
        const parts = [];
        parts.push(`Smoke ${this.state.smoke ?? 'unknown'}`);
        parts.push(`CO ${this.state.carbonMonoxide ?? 'unknown'}`);
        if (this.state.isOnline === false) {
            parts.push('Offline');
        }
        if (this.state.isBatteryLow) {
            parts.push('Battery low');
        }
        if (this.state.isOccupied !== undefined) {
            parts.push(this.state.isOccupied ? 'Occupied' : 'Unoccupied');
        }
        return parts.join(', ');
    }
}
exports.ProtectAccessory = ProtectAccessory;
//# sourceMappingURL=protect.js.map