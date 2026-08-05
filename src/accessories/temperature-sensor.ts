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

import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge'
import type { NestDevice, TemperatureSensorState } from '../types/device'
import type { Logger } from '../utils/logger'
import type { MyNestPlatform } from '../platform'
import { NestAccessory } from './base'

export class TemperatureSensorAccessory extends NestAccessory<TemperatureSensorState> {
  #service!: Service

  constructor(
    platform: MyNestPlatform,
    accessory: PlatformAccessory,
    device: Extract<NestDevice, { identity: { kind: 'temperature_sensor' } }>,
    log: Logger,
  ) {
    super(platform, accessory, device, log)
    this.bindCharacteristics()
    this.binder.refresh()
  }

  protected bindCharacteristics(): void {
    const { Characteristic, Service: HapService } = this.platform

    this.#service = this.resolveService(HapService.TemperatureSensor)
    this.#service.setCharacteristic(Characteristic.Name, this.identity.name)

    this.binder.bind(
      this.#service,
      Characteristic.CurrentTemperature,
      () => this.state.temperatureC,
    )
    this.binder.bind(
      this.#service,
      Characteristic.StatusLowBattery,
      () => this.#toLowBatteryValue(),
    )

    // A separate battery service is what makes the level visible in the Home
    // app; StatusLowBattery on the sensor alone only ever shows a warning.
    const battery = this.resolveService(HapService.Battery)
    battery.setCharacteristic(Characteristic.Name, `${this.identity.name} Battery`)
    battery.setCharacteristic(
      Characteristic.ChargingState,
      Characteristic.ChargingState.NOT_CHARGEABLE,
    )

    this.binder.bind(battery, Characteristic.BatteryLevel, () => this.state.batteryLevel)
    this.binder.bind(battery, Characteristic.StatusLowBattery, () => this.#toLowBatteryValue())
  }

  #toLowBatteryValue(): CharacteristicValue | undefined {
    return this.toLowBatteryValue(this.state.isBatteryLow)
  }

  protected describeState(): string {
    const parts: string[] = []

    if (this.state.temperatureC !== undefined) {
      parts.push(`${this.state.temperatureC.toFixed(1)}\u00B0C`)
    }
    if (this.state.batteryLevel !== undefined) {
      parts.push(`Battery ${Math.round(this.state.batteryLevel)}%`)
    }
    if (this.state.isBatteryLow) {
      parts.push('Battery low')
    }

    return parts.length > 0 ? parts.join(', ') : 'No readings yet'
  }
}
