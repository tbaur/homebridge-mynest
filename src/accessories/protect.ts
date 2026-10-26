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
 * verdict that nobody has been seen for roughly ten minutes, and omitted for
 * a battery-powered Protect. Unknown power does not hide a boolean `auto_away`.
 *
 * So this accessory publishes occupancy only where that verdict exists, and
 * says why in the log when it does not. Presenting a ten-minute presence
 * signal as motion would be the easy thing to do and would make every
 * automation built on it wrong.
 *
 * Smoke and CO come from REST `topaz` only. Observe streams safety traits, but
 * no public schema maps them and every captured sample reads all-clear, so
 * those fields are not read. Every Protect still publishes both sensors. A
 * missing number faults the sensor and does not write a clear. When REST later
 * goes stale, tiles stay published (so HomeKit rooms and automations survive)
 * but are marked inactive and faulted. See `docs/PROTOCOL.md`.
 */

import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge'
import { PROTECT_OCCUPANCY_HOLD_OFF_SEC } from '../settings'
import type { AlarmLevel, NestDevice, ProtectState } from '../types/device'
import { describeOccupancySource } from '../state/protect-state'
import type { Logger } from '../utils/logger'
import type { MyNestPlatform } from '../platform'
import { NestAccessory } from './base'

export class ProtectAccessory extends NestAccessory<ProtectState> {
  /** Once per process — the hint is the same for every Protect. */
  static #didLogOccupancyHint = false

  #smokeService: Service | null = null
  #coService: Service | null = null
  #didLogMissingAlarms = false
  #didLogAlarmFeedStale = false
  /** Last occupancy-omission sentence, so a repeating reason logs once. */
  #occupancyOmission: string | null = null

  /** @internal Clears the process-wide occupancy hint flag (tests only). */
  static resetOccupancyHintForTests(): void {
    ProtectAccessory.#didLogOccupancyHint = false
  }

  constructor(
    platform: MyNestPlatform,
    accessory: PlatformAccessory,
    device: Extract<NestDevice, { identity: { kind: 'protect' } }>,
    log: Logger,
  ) {
    super(platform, accessory, device, log)
    this.bindCharacteristics()
    this.binder.refresh()
  }

  protected bindCharacteristics(): void {
    this.#ensureAlarmServices()
    this.#ensureBatteryService()
    this.#bindOccupancy()
    this.#bindTemperature()
  }

  protected onServicesMayChange(): void {
    this.#ensureAlarmServices()
    this.#ensureBatteryService()
    this.#bindOccupancy()
    this.#bindTemperature()
  }

  /**
   * Publish smoke and CO for every Protect.
   *
   * HAP defaults SmokeDetected to "not detected". A missing number therefore
   * must not be written as a clear: the reader returns undefined, and the
   * sensor is marked inactive and faulted. Services stay through REST outages
   * so rooms and automations keep their targets.
   *
   * Each sensor is gated on its own reading. Nest returns different topaz
   * subsets per firmware, and a bucket carrying `smoke_status` without
   * `co_status` must not show a live CO clear.
   */
  #ensureAlarmServices(): void {
    const { Characteristic, Service: HapService } = this.platform
    const hasSmoke = this.state.smoke !== undefined
    const hasCarbonMonoxide = this.state.carbonMonoxide !== undefined

    this.#smokeService = this.resolveService(HapService.SmokeSensor)
    this.#smokeService.setCharacteristic(Characteristic.Name, `${this.identity.name} Smoke`)
    this.binder.bind(
      this.#smokeService,
      Characteristic.SmokeDetected,
      () => this.#toSmokeValue(this.state.smoke),
    )
    this.#bindAlarmHealth(this.#smokeService, () => this.#isLevelLive(this.state.smoke))

    this.#coService = this.resolveService(HapService.CarbonMonoxideSensor)
    this.#coService.setCharacteristic(Characteristic.Name, `${this.identity.name} CO`)
    this.binder.bind(
      this.#coService,
      Characteristic.CarbonMonoxideDetected,
      () => this.#toCarbonMonoxideValue(this.state.carbonMonoxide),
    )
    this.#bindAlarmHealth(this.#coService, () => this.#isLevelLive(this.state.carbonMonoxide))

    // Battery lives on the alarm tiles. Those tiles always exist.
    this.removeService(HapService.Battery)

    if (!hasSmoke && !hasCarbonMonoxide && this.state.isAlarmFeedStale !== true) {
      if (!this.#didLogMissingAlarms) {
        this.#didLogMissingAlarms = true
        this.log.info(`${this.identity.name}: no smoke/CO reading yet`)
      }
    } else {
      this.#didLogMissingAlarms = false
    }

    if (this.state.isAlarmFeedStale) {
      if (!this.#didLogAlarmFeedStale) {
        this.#didLogAlarmFeedStale = true
        // The transport logs the house-wide outage once at warn.
        this.log.debug(`${this.identity.name}: smoke/CO marked inactive`)
      }
    } else if (this.#didLogAlarmFeedStale) {
      this.#didLogAlarmFeedStale = false
      this.log.debug(`${this.identity.name}: smoke/CO live again`)
    }
  }

  /**
   * A clear is live only while Nest has supplied a number, the REST feed is
   * fresh, Nest still reports the Protect, and Observe has not reported it
   * offline. A fresh warning or emergency stays live when Observe reports the
   * Protect offline.
   */
  #isLevelLive(level: AlarmLevel | undefined): boolean {
    if (level === undefined || this.state.isAlarmFeedStale === true || this.isUnreported) {
      return false
    }
    if (level === 'warning' || level === 'emergency') {
      return true
    }
    return this.state.isOnline !== false
  }

  /** Battery plus liveness, for one alarm tile. */
  #bindAlarmHealth(service: Service, isLive: () => boolean): void {
    const { Characteristic } = this.platform

    if (this.state.isBatteryLow === true || this.state.isBatteryLow === false) {
      this.binder.bind(
        service,
        Characteristic.StatusLowBattery,
        () => this.#toLowBatteryValue(),
      )
    }
    this.binder.bind(service, Characteristic.StatusActive, () => isLive())
    this.binder.bind(
      service,
      Characteristic.StatusFault,
      () => isLive()
        ? Characteristic.StatusFault.NO_FAULT
        : Characteristic.StatusFault.GENERAL_FAULT,
    )
  }

  /** Used by the occupancy tile. Smoke and CO use `#bindAlarmHealth`. */
  #bindLiveness(service: Service): void {
    const { Characteristic } = this.platform

    this.binder.bind(service, Characteristic.StatusActive, () => this.#isAlarmReadingLive())
    this.binder.bind(
      service,
      Characteristic.StatusFault,
      () => this.#isAlarmReadingLive()
        ? Characteristic.StatusFault.NO_FAULT
        : Characteristic.StatusFault.GENERAL_FAULT,
    )
  }

  /**
   * Occupancy is live only while Nest still reports the Protect, Observe has
   * not reported it offline, and the REST feed is fresh.
   */
  #isAlarmReadingLive(): boolean {
    return this.state.isOnline !== false && this.state.isAlarmFeedStale !== true && !this.isUnreported
  }

  /**
   * Battery is reported on the smoke and CO tiles.
   *
   * Those tiles always exist, so a second Battery service would show the same
   * pack twice.
   */
  #ensureBatteryService(): void {
    this.removeService(this.platform.Service.Battery)
  }

  /**
   * Publish occupancy only where Nest actually reports it.
   *
   * A device with no verdict gets no sensor at all rather than one stuck at
   * "not occupied", which would look like a working sensor reporting an empty
   * house forever.
   */
  #bindOccupancy(): void {
    const { Characteristic, Service: HapService } = this.platform
    // Keep the service through REST outages when we still have a last verdict
    // (`unavailable_rest_stale` + isOccupied) so automations are not torn down.
    const isAvailable = this.config.exposeProtectOccupancy
      && this.state.isOccupied !== undefined
      && (this.state.occupancySource === 'auto_away'
        || this.state.occupancySource === 'unavailable_rest_stale')

    if (!isAvailable) {
      this.removeService(HapService.OccupancySensor)

      const reason = this.config.exposeProtectOccupancy
        ? describeOccupancySource(this.state.occupancySource)
        : 'turned off in settings'
      if (this.#occupancyOmission !== reason) {
        this.#occupancyOmission = reason
        this.log.info(`${this.identity.name}: no occupancy sensor (${reason})`)
      }
      return
    }

    if (this.state.occupancySource === 'unavailable_rest_stale') {
      const reason = describeOccupancySource(this.state.occupancySource)
      if (this.#occupancyOmission !== reason) {
        this.#occupancyOmission = reason
        this.log.info(`${this.identity.name}: ${reason}`)
      }
    } else {
      this.#occupancyOmission = null
    }

    const service = this.resolveService(HapService.OccupancySensor)
    service.setCharacteristic(Characteristic.Name, `${this.identity.name} Occupancy`)

    this.binder.bind(
      service,
      Characteristic.OccupancyDetected,
      () => this.state.isOccupied === undefined
        ? undefined
        : this.state.isOccupied
          ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    )
    this.#bindLiveness(service)

    if (!ProtectAccessory.#didLogOccupancyHint) {
      ProtectAccessory.#didLogOccupancyHint = true
      this.log.info(
        `Protect occupancy uses Nest auto-away (about ${PROTECT_OCCUPANCY_HOLD_OFF_SEC / 60} min), not motion`,
      )
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
  #bindTemperature(): void {
    const { Characteristic, Service: HapService } = this.platform

    if (!this.config.exposeProtectTemperature) {
      this.removeService(HapService.TemperatureSensor)
      this.removeService(HapService.HumiditySensor)
      return
    }

    if (this.state.temperatureC === undefined) {
      this.removeService(HapService.TemperatureSensor)
    } else {
      const service = this.resolveService(HapService.TemperatureSensor)
      service.setCharacteristic(Characteristic.Name, `${this.identity.name} Temperature`)
      this.binder.bind(service, Characteristic.CurrentTemperature, () => this.state.temperatureC)
    }

    if (this.state.humidity === undefined) {
      this.removeService(HapService.HumiditySensor)
      return
    }

    const humidity = this.resolveService(HapService.HumiditySensor)
    humidity.setCharacteristic(Characteristic.Name, `${this.identity.name} Humidity`)
    this.binder.bind(humidity, Characteristic.CurrentRelativeHumidity, () => this.state.humidity)
  }

  /**
   * Map Nest's three-level scale onto HomeKit's binary alarm.
   *
   * Nest's middle level is a "heads up" — enough smoke to mention, not enough
   * to sound the alarm. It is reported as detected anyway. On a life-safety
   * device, an alert the user did not need is a far better failure than a real
   * one HomeKit stayed quiet about.
   */
  #toSmokeValue(level: AlarmLevel | undefined): CharacteristicValue | undefined {
    const { Characteristic } = this.platform
    if (level === undefined) {
      return undefined
    }
    return level === 'ok'
      ? Characteristic.SmokeDetected.SMOKE_NOT_DETECTED
      : Characteristic.SmokeDetected.SMOKE_DETECTED
  }

  #toCarbonMonoxideValue(level: AlarmLevel | undefined): CharacteristicValue | undefined {
    const { Characteristic } = this.platform
    if (level === undefined) {
      return undefined
    }
    return level === 'ok'
      ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL
      : Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
  }

  #toLowBatteryValue(): CharacteristicValue | undefined {
    return this.toLowBatteryValue(this.state.isBatteryLow)
  }

  protected describeState(): string {
    const parts: string[] = []

    parts.push(`Smoke ${this.state.smoke ?? 'unknown'}`)
    parts.push(`CO ${this.state.carbonMonoxide ?? 'unknown'}`)

    if (this.state.isOnline === false) {
      parts.push('Offline')
    }
    if (this.state.isBatteryLow) {
      parts.push('Battery low')
    }
    if (this.state.isOccupied !== undefined) {
      parts.push(this.state.isOccupied ? 'Occupied' : 'Unoccupied')
    }

    return parts.join(', ')
  }
}
