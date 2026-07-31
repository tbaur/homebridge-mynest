"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest Temperature Sensor as a HomeKit temperature sensor.
 *
 * These are battery-only pucks that report through whichever thermostat they
 * are paired to, so their readings arrive on both transports and can lag by a
 * few minutes. That is the device, not the plugin.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TemperatureSensorAccessory = void 0;
const base_1 = require("./base");
class TemperatureSensorAccessory extends base_1.NestAccessory {
    #service;
    constructor(platform, accessory, device, log) {
        super(platform, accessory, device, log);
        this.bindCharacteristics();
        this.binder.refresh();
    }
    bindCharacteristics() {
        const { Characteristic, Service: HapService } = this.platform;
        this.#service = this.resolveService(HapService.TemperatureSensor);
        this.#service.setCharacteristic(Characteristic.Name, this.identity.name);
        this.binder.bind(this.#service, Characteristic.CurrentTemperature, () => this.state.temperatureC);
        this.binder.bind(this.#service, Characteristic.StatusLowBattery, () => this.#toLowBatteryValue());
        // A separate battery service is what makes the level visible in the Home
        // app; StatusLowBattery on the sensor alone only ever shows a warning.
        const battery = this.resolveService(HapService.Battery);
        battery.setCharacteristic(Characteristic.Name, `${this.identity.name} Battery`);
        battery.setCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGEABLE);
        this.binder.bind(battery, Characteristic.BatteryLevel, () => this.state.batteryLevel);
        this.binder.bind(battery, Characteristic.StatusLowBattery, () => this.#toLowBatteryValue());
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
    describeState() {
        const parts = [];
        if (this.state.temperatureC !== undefined) {
            parts.push(`${this.state.temperatureC.toFixed(1)}\u00B0C`);
        }
        if (this.state.batteryLevel !== undefined) {
            parts.push(`Battery ${Math.round(this.state.batteryLevel)}%`);
        }
        if (this.state.isBatteryLow) {
            parts.push('Battery low');
        }
        return parts.length > 0 ? parts.join(', ') : 'No readings yet';
    }
}
exports.TemperatureSensorAccessory = TemperatureSensorAccessory;
//# sourceMappingURL=temperature-sensor.js.map