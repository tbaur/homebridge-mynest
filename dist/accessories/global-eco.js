"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview House-wide Eco Mode switch (all Nest thermostats).
 *
 * HomeKit has no Eco thermostat mode, so Eco is a Switch. This accessory turns
 * Eco on or off for every published thermostat at once. What the switch shows
 * is decided by `state/global-eco-state.ts`; this class owns HomeKit, the
 * expiry timer, and the log lines.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GlobalEcoAccessory = void 0;
const settings_1 = require("../settings");
const global_eco_state_1 = require("../state/global-eco-state");
const bound_characteristics_1 = require("../utils/bound-characteristics");
const sanitizers_1 = require("../utils/sanitizers");
/** Optional Switch that drives Eco on every thermostat. */
class GlobalEcoAccessory {
    #platform;
    #accessory;
    #log;
    #binder;
    #state;
    /**
     * Backstop for {@link PENDING_ECO_MAX_MS}.
     *
     * The age check on a Nest report only runs when Nest sends another one. If
     * Observe goes quiet right after a write, nothing else would expire it.
     */
    #pendingTimer = null;
    constructor(platform, accessory, log) {
        this.#platform = platform;
        this.#accessory = accessory;
        this.#log = log;
        this.#binder = new bound_characteristics_1.CharacteristicBinder(log, settings_1.GLOBAL_ECO_DISPLAY_NAME);
        this.#applyAccessoryInformation();
        const cachedOn = this.#accessory.getService(this.#platform.Service.Switch)
            ?.getCharacteristic(this.#platform.Characteristic.On).value;
        this.#state = (0, global_eco_state_1.initialGlobalEcoState)(cachedOn === true);
        this.#bindSwitch();
        this.#binder.refresh();
    }
    /** Reflect whether every Nest thermostat is currently in Eco. */
    updateAllEco(allEco) {
        this.#dispatch({ type: 'nest_report', allEco, nowMs: Date.now() });
        this.#binder.refresh();
    }
    /**
     * Release the pending-write backstop.
     *
     * Called when the switch is removed or the platform stops. The timer is
     * `unref`'d so it cannot hold the process open, but without this it could
     * still fire up to 45s later and refresh a torn-down accessory.
     */
    dispose() {
        this.#clearTimer();
    }
    #dispatch(event) {
        const { state, outcome } = (0, global_eco_state_1.reduceGlobalEco)(this.#state, event);
        this.#state = state;
        this.#logOutcome(outcome);
        if (state.pending === null) {
            this.#clearTimer();
        }
        else if (event.type === 'write_sent') {
            this.#armTimer();
        }
    }
    #logOutcome(outcome) {
        const prefix = `${settings_1.GLOBAL_ECO_DISPLAY_NAME}: Eco change not confirmed in ${global_eco_state_1.PENDING_ECO_MAX_MS / 1000}s`;
        if (outcome === 'expired_to_nest') {
            this.#log.warn(`${prefix}, showing Nest state`);
        }
        else if (outcome === 'expired_without_report') {
            this.#log.warn(prefix);
        }
    }
    #armTimer() {
        this.#clearTimer();
        this.#pendingTimer = setTimeout(() => {
            this.#pendingTimer = null;
            this.#dispatch({ type: 'expire' });
            this.#binder.refresh();
        }, global_eco_state_1.PENDING_ECO_MAX_MS);
        // Homebridge owns the process lifetime; this must not hold Node open.
        this.#pendingTimer.unref?.();
    }
    #clearTimer() {
        if (this.#pendingTimer) {
            clearTimeout(this.#pendingTimer);
            this.#pendingTimer = null;
        }
    }
    /**
     * Push the switch after `onSet` returns.
     *
     * HAP writes the requested On value after the setter resolves, so a refresh
     * inside the setter is overwritten.
     */
    #refreshSwitch = () => {
        this.#binder.refresh();
    };
    #bindSwitch() {
        const { Characteristic, Service: HapService } = this.#platform;
        const service = this.#accessory.getService(HapService.Switch)
            ?? this.#accessory.addService(HapService.Switch, settings_1.GLOBAL_ECO_DISPLAY_NAME);
        service.setCharacteristic(Characteristic.Name, settings_1.GLOBAL_ECO_DISPLAY_NAME);
        this.#accessory
            .setPrimaryService?.(service);
        this.#binder.bind(service, Characteristic.On, () => this.#state.shown, {
            write: async (value) => {
                await this.#setEco(value === true || value === 1);
            },
        });
    }
    async #setEco(ecoOn) {
        const startedAtMs = Date.now();
        let sent;
        try {
            sent = await this.#platform.applyGlobalEcoWrite(ecoOn);
        }
        catch (error) {
            // Same distinction the thermostat draws: a refusal resolves, but a write
            // that reached Nest and failed is reported so the user is not left
            // watching a switch flip back with no stated reason. The deferred refresh
            // clears HAP's error status a tick later, so it cannot stick.
            this.#log.warn(`${settings_1.GLOBAL_ECO_DISPLAY_NAME}: Eco update failed: ${(0, sanitizers_1.sanitizeError)(error)}`);
            setImmediate(this.#refreshSwitch);
            const { HAPStatus, HapStatusError } = this.#platform.api.hap;
            throw new HapStatusError(-70402 /* HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
        }
        if (!sent) {
            if (!this.#platform.resolvedConfig.allowThermostatControl) {
                this.#log.warn(`${settings_1.GLOBAL_ECO_DISPLAY_NAME}: thermostat control is off, change ignored`);
            }
            setImmediate(this.#refreshSwitch);
            return;
        }
        this.#log.info(`${settings_1.GLOBAL_ECO_DISPLAY_NAME}: Eco ${ecoOn ? 'on' : 'off'} for all thermostats`);
        // Optimistic until Nest's aggregate matches. No refresh here: HAP is about
        // to write the same value.
        this.#dispatch({ type: 'write_sent', ecoOn, startedAtMs, nowMs: Date.now() });
    }
    #applyAccessoryInformation() {
        const { Characteristic, Service: HapService } = this.#platform;
        const service = this.#accessory.getService(HapService.AccessoryInformation)
            ?? this.#accessory.addService(HapService.AccessoryInformation);
        service
            .setCharacteristic(Characteristic.Manufacturer, settings_1.MANUFACTURER)
            .setCharacteristic(Characteristic.Name, settings_1.GLOBAL_ECO_DISPLAY_NAME)
            .setCharacteristic(Characteristic.Model, 'Eco Mode')
            .setCharacteristic(Characteristic.SerialNumber, settings_1.GLOBAL_ECO_DEVICE_ID);
    }
}
exports.GlobalEcoAccessory = GlobalEcoAccessory;
