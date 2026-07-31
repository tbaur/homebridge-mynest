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

import type { PlatformAccessory, Service } from 'homebridge'
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
    this.binder = new CharacteristicBinder(log)

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
    this.identity = device.identity
    this.state = device.state as TState

    this.#applyAccessoryInformation()
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

  /** Info on a change, debug otherwise, so the log follows the house. */
  #logSummary(): void {
    const summary = this.describeState()

    if (this.#lastSummary === null || this.#lastSummary === summary) {
      this.log.debug(`${this.identity.name}: ${summary}`)
    } else {
      this.log.info(`${this.identity.name}: ${summary}`)
    }

    this.#lastSummary = summary
  }
}
