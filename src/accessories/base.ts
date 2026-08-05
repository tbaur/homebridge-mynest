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

import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge'
import { MANUFACTURER } from '../settings'
import type { DeviceIdentity, DeviceKind, NestDevice } from '../types/device'
import type { ResolvedConfig } from '../types/config'
import type { Logger } from '../utils/logger'
import { CharacteristicBinder } from '../utils/bound-characteristics'
import type { MyNestPlatform } from '../platform'

/** What the platform persists on an accessory so it survives a restart. */
export interface AccessoryContext {
  deviceId: string
  kind: DeviceKind
  displayName: string
  /**
   * Non-Nest accessories (e.g. house-wide Eco switch). Skipped by Nest inventory
   * prune so they are not unregistered as "gone" devices.
   */
  synthetic?: 'global_eco'
}

/** Whether any field published as Accessory Information differs. */
function hasIdentityChanged(previous: DeviceIdentity, next: DeviceIdentity): boolean {
  return previous.name !== next.name
    || previous.model !== next.model
    || previous.serialNumber !== next.serialNumber
    || previous.firmwareVersion !== next.firmwareVersion
    || previous.id !== next.id
}

/** One HomeKit accessory backed by one Nest device. */
export abstract class NestAccessory<TState> {
  protected readonly platform: MyNestPlatform
  protected readonly accessory: PlatformAccessory
  protected readonly log: Logger
  protected readonly config: ResolvedConfig
  protected readonly binder: CharacteristicBinder

  protected identity: DeviceIdentity
  protected state: TState

  /** Last summary emitted, so an unchanged one stays at debug. */
  #lastSummary: string | null = null

  constructor(
    platform: MyNestPlatform,
    accessory: PlatformAccessory,
    device: { identity: DeviceIdentity, state: TState },
    log: Logger,
  ) {
    this.platform = platform
    this.accessory = accessory
    this.log = log
    this.config = platform.resolvedConfig
    this.identity = device.identity
    this.state = device.state
    this.binder = new CharacteristicBinder(log, device.identity.name)

    this.#applyAccessoryInformation()
  }

  get deviceId(): string {
    return this.identity.id
  }

  /**
   * Take new state and push it to HomeKit.
   *
   * Called on every merged update, which on a busy home is several times a
   * minute. HAP suppresses notifications for unchanged values, so pushing
   * unconditionally is cheaper than diffing here.
   */
  update(device: NestDevice): void {
    const previousIdentity = this.identity
    this.identity = device.identity
    this.state = device.state as TState

    // Only when it actually changed. These four values essentially never do, and
    // re-applying them ran HAP's full value-validation path four times per
    // device per refresh on the hot update path.
    if (hasIdentityChanged(previousIdentity, device.identity)) {
      this.#applyAccessoryInformation()
    }
    this.onServicesMayChange()
    this.binder.refresh()
    this.#logSummary()
  }

  /**
   * Bind or remove optional services when Nest state becomes available later.
   *
   * Default is a no-op. Protect occupancy and thermostat humidity use this so
   * a device that starts Observe-only can grow services once REST catches up.
   */
  protected onServicesMayChange(): void {
    // Optional for subclasses.
  }

  /** Bind characteristics. Called once, from the concrete accessory. */
  protected abstract bindCharacteristics(): void

  /** A one-line description of current state, for the log. */
  protected abstract describeState(): string

  /**
   * Find an existing service or create it.
   *
   * Accessories are restored from Homebridge's cache across restarts, so a
   * service is usually already there; adding a duplicate would publish the
   * device twice in the Home app.
   */
  protected resolveService(type: typeof Service | Parameters<PlatformAccessory['getService']>[0]): Service {
    const existing = this.accessory.getService(type as never)
    if (existing) {
      return existing
    }
    return this.accessory.addService(type as never)
  }

  /**
   * Remove a service the user has turned off in config.
   *
   * Without this, disabling an option would leave a dead tile in the Home app
   * reporting whatever value it last held.
   */
  protected removeService(type: Parameters<PlatformAccessory['getService']>[0]): void {
    const existing = this.accessory.getService(type as never)
    if (!existing) {
      return
    }
    this.binder.unbindService(existing)
    this.accessory.removeService(existing)
  }

  /**
   * Map a low-battery verdict onto HomeKit's enum.
   *
   * `undefined` when Nest has said nothing, so the binder leaves the last known
   * value in place rather than publishing "normal" on no evidence.
   */
  protected toLowBatteryValue(isBatteryLow: boolean | undefined): CharacteristicValue | undefined {
    const { StatusLowBattery } = this.platform.Characteristic
    if (isBatteryLow === undefined) {
      return undefined
    }
    return isBatteryLow
      ? StatusLowBattery.BATTERY_LEVEL_LOW
      : StatusLowBattery.BATTERY_LEVEL_NORMAL
  }

  #applyAccessoryInformation(): void {
    const { Characteristic, Service: HapService } = this.platform
    const service = this.accessory.getService(HapService.AccessoryInformation)
      ?? this.accessory.addService(HapService.AccessoryInformation)

    service
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Name, this.identity.name)
      .setCharacteristic(Characteristic.Model, this.identity.model ?? 'Nest Device')
      .setCharacteristic(Characteristic.SerialNumber, this.identity.serialNumber ?? this.identity.id)

    if (this.identity.firmwareVersion) {
      service.setCharacteristic(Characteristic.FirmwareRevision, this.identity.firmwareVersion)
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
  #logSummary(): void {
    const summary = this.describeState()
    const isFirst = this.#lastSummary === null

    if (!isFirst && this.#lastSummary === summary) {
      this.log.debug(`${this.identity.name}: ${summary}`)
    } else {
      this.log.info(`${this.identity.name}: ${summary}`)
    }

    this.#lastSummary = summary
  }
}
