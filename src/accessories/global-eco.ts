/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview House-wide Eco Mode switch (all Nest thermostats).
 *
 * HomeKit has no Eco thermostat mode, so Eco is a Switch. This accessory turns
 * Eco on or off for every published thermostat at once.
 */

import type { PlatformAccessory, Service } from 'homebridge'
import {
  GLOBAL_ECO_DEVICE_ID,
  GLOBAL_ECO_DISPLAY_NAME as DISPLAY_NAME,
  MANUFACTURER,
} from '../settings'
import type { Logger } from '../utils/logger'
import { CharacteristicBinder } from '../utils/bound-characteristics'
import { sanitizeError } from '../utils/sanitizers'
import type { MyNestPlatform } from '../platform'

/**
 * How long a successful HomeKit Eco write may ignore Nest aggregates that have
 * not yet matched. After this, Nest truth wins (Nest app / failed Observe).
 */
const PENDING_ECO_MAX_MS = 45_000

/** Optional Switch that drives Eco on every thermostat. */
export class GlobalEcoAccessory {
  readonly #platform: MyNestPlatform
  readonly #accessory: PlatformAccessory
  readonly #log: Logger
  readonly #binder: CharacteristicBinder
  #allEco = false
  /**
   * Desired aggregate after a successful HomeKit write. While set, Nest sync
   * must not push a partial aggregate (staggered Eco confirms) or unrelated
   * inventory traffic will snap the switch back.
   */
  #pendingAllEco: boolean | null = null
  #pendingSinceMs: number | null = null
  /**
   * Backstop for {@link PENDING_ECO_MAX_MS}.
   *
   * The age check in {@link updateAllEco} only runs when Nest sends another
   * update. If Observe dies right after a successful write, nothing would ever
   * clear the optimistic value and the switch would hold it indefinitely.
   */
  #pendingTimer: NodeJS.Timeout | null = null

  constructor(platform: MyNestPlatform, accessory: PlatformAccessory, log: Logger) {
    this.#platform = platform
    this.#accessory = accessory
    this.#log = log
    this.#binder = new CharacteristicBinder(log, DISPLAY_NAME)

    this.#applyAccessoryInformation()
    this.#bindSwitch()
    this.#binder.refresh()
  }

  /**
   * Reflect whether every Nest thermostat is currently in Eco.
   *
   * While a HomeKit write is pending confirmation, ignore Nest aggregates that
   * do not yet match the desired value (partial Eco reports). If Nest never
   * matches within {@link PENDING_ECO_MAX_MS}, take Nest truth.
   */
  updateAllEco(allEco: boolean): void {
    if (this.#pendingAllEco !== null) {
      if (allEco === this.#pendingAllEco) {
        this.#clearPending()
      } else if (
        this.#pendingSinceMs !== null
        && Date.now() - this.#pendingSinceMs >= PENDING_ECO_MAX_MS
      ) {
        this.#expirePending()
      } else {
        return
      }
    }
    this.#allEco = allEco
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
    this.#clearPending()
  }

  #clearPending(): void {
    this.#pendingAllEco = null
    this.#pendingSinceMs = null
    if (this.#pendingTimer) {
      clearTimeout(this.#pendingTimer)
      this.#pendingTimer = null
    }
  }

  /** Give up on an unconfirmed write and let Nest's own value stand. */
  #expirePending(): void {
    this.#log.warn(
      `${DISPLAY_NAME}: Nest did not confirm Eco change within ${PENDING_ECO_MAX_MS / 1000}s — following Nest`,
    )
    this.#clearPending()
  }

  /** Start the backstop that gives Nest the last word even if it goes quiet. */
  #armPending(ecoOn: boolean): void {
    this.#clearPending()
    this.#pendingAllEco = ecoOn
    this.#pendingSinceMs = Date.now()
    this.#pendingTimer = setTimeout(() => {
      this.#pendingTimer = null
      if (this.#pendingAllEco === null) {
        return
      }
      this.#expirePending()
      this.#binder.refresh()
    }, PENDING_ECO_MAX_MS)
    // Homebridge owns the process lifetime; this must not hold Node open.
    this.#pendingTimer.unref?.()
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
      () => this.#allEco,
      {
        write: async (value) => {
          await this.#setEco(value === true || value === 1)
        },
      },
    )
  }

  async #setEco(ecoOn: boolean): Promise<void> {
    try {
      const sent = await this.#platform.applyGlobalEcoWrite(ecoOn)
      if (!sent) {
        this.#clearPending()
        if (!this.#platform.resolvedConfig.allowThermostatControl) {
          this.#log.warn(
            `${DISPLAY_NAME}: ignoring HomeKit change — enable Allow thermostat control in config.`,
          )
        }
        // HAP assigns On after onSet; revert to Nest-derived `#allEco`.
        setImmediate(() => this.#binder.refresh())
        return
      }
      this.#log.info(
        `${DISPLAY_NAME}: ${ecoOn ? 'Updating all thermostats to Eco' : 'Clearing Eco on all thermostats'}`,
      )
      // Optimistic until Nest's all-Eco aggregate matches; do not refresh here
      // or HAP's post-onSet value is overwritten by a stale read.
      this.#armPending(ecoOn)
      this.#allEco = ecoOn
    } catch (error) {
      this.#clearPending()
      this.#log.warn(`${DISPLAY_NAME}: Eco update failed: ${sanitizeError(error)}`)
      setImmediate(() => this.#binder.refresh())

      // Same distinction the thermostat draws: a refusal above resolves, but a
      // write that reached Nest and failed is reported so the user is not left
      // watching a switch flip back with no stated reason. The deferred refresh
      // clears HAP's error status a tick later, so it cannot stick.
      const { HAPStatus, HapStatusError } = this.#platform.api.hap
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
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
