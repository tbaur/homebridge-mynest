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

import type { PlatformAccessory, Service } from 'homebridge'
import {
  GLOBAL_ECO_DEVICE_ID,
  GLOBAL_ECO_DISPLAY_NAME as DISPLAY_NAME,
  MANUFACTURER,
} from '../settings'
import {
  PENDING_ECO_MAX_MS,
  initialGlobalEcoState,
  reduceGlobalEco,
  type GlobalEcoEvent,
  type GlobalEcoOutcome,
  type GlobalEcoState,
} from '../state/global-eco-state'
import type { Logger } from '../utils/logger'
import { CharacteristicBinder } from '../utils/bound-characteristics'
import { sanitizeError } from '../utils/sanitizers'
import type { MyNestPlatform } from '../platform'

/** Optional Switch that drives Eco on every thermostat. */
export class GlobalEcoAccessory {
  readonly #platform: MyNestPlatform
  readonly #accessory: PlatformAccessory
  readonly #log: Logger
  readonly #binder: CharacteristicBinder
  #state: GlobalEcoState
  /**
   * Backstop for {@link PENDING_ECO_MAX_MS}.
   *
   * The age check on a Nest report only runs when Nest sends another one. If
   * Observe goes quiet right after a write, nothing else would expire it.
   */
  #pendingTimer: NodeJS.Timeout | null = null

  constructor(platform: MyNestPlatform, accessory: PlatformAccessory, log: Logger) {
    this.#platform = platform
    this.#accessory = accessory
    this.#log = log
    this.#binder = new CharacteristicBinder(log, DISPLAY_NAME)

    this.#applyAccessoryInformation()
    const cachedOn = this.#accessory.getService(this.#platform.Service.Switch)
      ?.getCharacteristic(this.#platform.Characteristic.On).value
    this.#state = initialGlobalEcoState(cachedOn === true)
    this.#bindSwitch()
    this.#binder.refresh()
  }

  /** Reflect whether every Nest thermostat is currently in Eco. */
  updateAllEco(allEco: boolean): void {
    this.#dispatch({ type: 'nest_report', allEco, nowMs: Date.now() })
    this.#binder.refresh()
  }

  /**
   * Release the pending-write backstop.
   *
   * Called when the switch is removed or the platform stops. The timer is
   * `unref`'d so it cannot hold the process open, but without this it could
   * still fire up to 45s later and refresh a torn-down accessory.
   */
  dispose(): void {
    this.#clearTimer()
  }

  #dispatch(event: GlobalEcoEvent): void {
    const { state, outcome } = reduceGlobalEco(this.#state, event)
    this.#state = state
    this.#logOutcome(outcome)
    if (state.pending === null) {
      this.#clearTimer()
    } else if (event.type === 'write_sent') {
      this.#armTimer()
    }
  }

  #logOutcome(outcome: GlobalEcoOutcome): void {
    const prefix = `${DISPLAY_NAME}: Eco change not confirmed in ${PENDING_ECO_MAX_MS / 1000}s`
    if (outcome === 'expired_to_nest') {
      this.#log.warn(`${prefix}, showing Nest state`)
    } else if (outcome === 'expired_without_report') {
      this.#log.warn(prefix)
    }
  }

  #armTimer(): void {
    this.#clearTimer()
    this.#pendingTimer = setTimeout(() => {
      this.#pendingTimer = null
      this.#dispatch({ type: 'expire' })
      this.#binder.refresh()
    }, PENDING_ECO_MAX_MS)
    // Homebridge owns the process lifetime; this must not hold Node open.
    this.#pendingTimer.unref?.()
  }

  #clearTimer(): void {
    if (this.#pendingTimer) {
      clearTimeout(this.#pendingTimer)
      this.#pendingTimer = null
    }
  }

  /**
   * Push the switch after `onSet` returns.
   *
   * HAP writes the requested On value after the setter resolves, so a refresh
   * inside the setter is overwritten.
   */
  readonly #refreshSwitch = (): void => {
    this.#binder.refresh()
  }

  #bindSwitch(): void {
    const { Characteristic, Service: HapService } = this.#platform
    const service = this.#accessory.getService(HapService.Switch)
      ?? this.#accessory.addService(HapService.Switch, DISPLAY_NAME)

    service.setCharacteristic(Characteristic.Name, DISPLAY_NAME)
    ;(this.#accessory as PlatformAccessory & { setPrimaryService?: (service: Service) => void })
      .setPrimaryService?.(service)

    this.#binder.bind(
      service,
      Characteristic.On,
      () => this.#state.shown,
      {
        write: async (value) => {
          await this.#setEco(value === true || value === 1)
        },
      },
    )
  }

  async #setEco(ecoOn: boolean): Promise<void> {
    const startedAtMs = Date.now()
    let sent: boolean
    try {
      sent = await this.#platform.applyGlobalEcoWrite(ecoOn)
    } catch (error) {
      // Same distinction the thermostat draws: a refusal resolves, but a write
      // that reached Nest and failed is reported so the user is not left
      // watching a switch flip back with no stated reason. The deferred refresh
      // clears HAP's error status a tick later, so it cannot stick.
      this.#log.warn(`${DISPLAY_NAME}: Eco update failed: ${sanitizeError(error)}`)
      setImmediate(this.#refreshSwitch)
      const { HAPStatus, HapStatusError } = this.#platform.api.hap
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }

    if (!sent) {
      if (!this.#platform.resolvedConfig.allowThermostatControl) {
        this.#log.warn(`${DISPLAY_NAME}: thermostat control is off, change ignored`)
      }
      setImmediate(this.#refreshSwitch)
      return
    }

    this.#log.info(
      `${DISPLAY_NAME}: Eco ${ecoOn ? 'on' : 'off'} for all thermostats`,
    )
    // Optimistic until Nest's aggregate matches. No refresh here: HAP is about
    // to write the same value.
    this.#dispatch({ type: 'write_sent', ecoOn, startedAtMs, nowMs: Date.now() })
  }

  #applyAccessoryInformation(): void {
    const { Characteristic, Service: HapService } = this.#platform
    const service = this.#accessory.getService(HapService.AccessoryInformation)
      ?? this.#accessory.addService(HapService.AccessoryInformation)

    service
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Name, DISPLAY_NAME)
      .setCharacteristic(Characteristic.Model, 'Eco Mode')
      .setCharacteristic(Characteristic.SerialNumber, GLOBAL_ECO_DEVICE_ID)
  }
}
