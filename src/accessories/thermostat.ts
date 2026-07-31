/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest thermostat as a HomeKit Thermostat service.
 *
 * Read-only in this version. Nest moved thermostats to its protobuf backend,
 * and on the account this plugin was developed against they do not appear in
 * the REST API at all — so the old REST write path cannot reach them, and the
 * protobuf write path has not been confirmed against a live device. Guessing
 * it would mean shipping code that changes what a house's heating is doing
 * based on an unverified payload, so the setpoint characteristics are
 * published without write handlers until that path is proven.
 */

import type { CharacteristicValue, Perms, PlatformAccessory, Service } from 'homebridge'
import { MAX_SETPOINT_C, MIN_SETPOINT_C, SETPOINT_STEP_C } from '../settings'
import type { HvacActivity, HvacMode, NestDevice, ThermostatState } from '../types/device'
import type { Logger } from '../utils/logger'
import type { MyNestPlatform } from '../platform'
import { NestAccessory } from './base'

/** Midpoint of the two setpoints, used for HomeKit's single target in range mode. */
function midpoint(low: number | undefined, high: number | undefined): number | undefined {
  if (low === undefined || high === undefined) {
    return undefined
  }
  return (low + high) / 2
}

export class ThermostatAccessory extends NestAccessory<ThermostatState> {
  #service!: Service

  constructor(
    platform: MyNestPlatform,
    accessory: PlatformAccessory,
    device: Extract<NestDevice, { identity: { kind: 'thermostat' } }>,
    log: Logger,
  ) {
    super(platform, accessory, device, log)
    this.bindCharacteristics()
    this.binder.refresh()
  }

  protected bindCharacteristics(): void {
    const { Characteristic, Service: HapService } = this.platform
    this.#service = this.resolveService(HapService.Thermostat)
    this.#service.setCharacteristic(Characteristic.Name, this.identity.name)

    this.binder.bind(
      this.#service,
      Characteristic.CurrentTemperature,
      () => this.state.currentTemperatureC,
    )

    this.binder.bind(
      this.#service,
      Characteristic.CurrentHeatingCoolingState,
      () => this.#currentHeatingCoolingState(),
    )

    // Offering a mode the equipment cannot deliver produces a control that
    // fails when used, so the list is narrowed to what Nest says it can do.
    this.binder.bind(
      this.#service,
      Characteristic.TargetHeatingCoolingState,
      () => this.#targetHeatingCoolingState(),
    )

    this.#bindSetpoint(Characteristic.TargetTemperature, () => this.#targetTemperature())
    this.#bindSetpoint(
      Characteristic.HeatingThresholdTemperature,
      () => this.state.targetTemperatureLowC,
    )
    this.#bindSetpoint(
      Characteristic.CoolingThresholdTemperature,
      () => this.state.targetTemperatureHighC,
    )

    // Nest owns what the device's own screen shows; HomeKit is always given
    // Celsius regardless.
    this.binder.bind(
      this.#service,
      Characteristic.TemperatureDisplayUnits,
      () => this.state.displayUnit === 'F'
        ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT
        : Characteristic.TemperatureDisplayUnits.CELSIUS,
    )

    this.#applyCharacteristicProps()
    this.#bindHumidity()
  }

  protected onServicesMayChange(): void {
    this.#applyCharacteristicProps()
    this.#bindHumidity()
  }

  /**
   * Refresh mode/setpoint props when Nest capabilities arrive after first publish.
   *
   * The opening Observe snapshot often omits equipment capabilities; applying
   * props only at construction would freeze HEAT/COOL/AUTO forever.
   */
  #applyCharacteristicProps(): void {
    const { Characteristic } = this.platform

    this.#service.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({
      validValues: this.#supportedTargetStates(),
      perms: this.#readOnlyPerms(),
    })

    for (const type of [
      Characteristic.TargetTemperature,
      Characteristic.HeatingThresholdTemperature,
      Characteristic.CoolingThresholdTemperature,
    ]) {
      this.#service.getCharacteristic(type).setProps({
        minValue: MIN_SETPOINT_C,
        maxValue: MAX_SETPOINT_C,
        minStep: SETPOINT_STEP_C,
        perms: this.#readOnlyPerms(),
      })
    }

    this.#service.getCharacteristic(Characteristic.TemperatureDisplayUnits).setProps({
      perms: this.#readOnlyPerms(),
    })
  }

  /** Humidity often arrives after the first Observe snapshot; bind when present. */
  #bindHumidity(): void {
    if (this.state.currentHumidity === undefined) {
      return
    }

    this.binder.bind(
      this.#service,
      this.platform.Characteristic.CurrentRelativeHumidity,
      () => this.state.currentHumidity,
    )
  }

  /**
   * Publish one setpoint characteristic within the range Nest accepts.
   *
   * HAP validates the characteristic's current value against new props, and a
   * setpoint that has not been reported yet still holds HAP's own default of
   * 0 °C — below Nest's floor. Worse: HomeKit polls `onGet`, and returning
   * `null` for Apple temperature characteristics logs a warning on every poll
   * (Cooling Threshold on heat-only units was the noisy case). So the reader
   * always returns an in-range number: Nest's value when known, otherwise the
   * last HAP value or Nest's floor as a non-null placeholder until the first
   * real update.
   */
  #bindSetpoint(
    type: Parameters<typeof this.binder.bind>[1],
    read: () => number | undefined,
  ): void {
    const characteristic = this.binder.bind(this.#service, type, () => {
      const value = read()
      if (value !== undefined) {
        return value
      }
      const current = this.#service.getCharacteristic(type).value
      return typeof current === 'number'
        && Number.isFinite(current)
        && current >= MIN_SETPOINT_C
        && current <= MAX_SETPOINT_C
        ? current
        : MIN_SETPOINT_C
    })

    if (typeof characteristic.value === 'number' && characteristic.value < MIN_SETPOINT_C) {
      characteristic.updateValue(MIN_SETPOINT_C)
    }

    characteristic.setProps({
      minValue: MIN_SETPOINT_C,
      maxValue: MAX_SETPOINT_C,
      minStep: SETPOINT_STEP_C,
      perms: this.#readOnlyPerms(),
    })
  }

  /**
   * Permissions for a control this version cannot act on.
   *
   * Dropping the write permission makes the Home app present the thermostat as
   * a readout. Leaving it writable would offer a slider that silently fails,
   * which is a worse answer than not offering one.
   */
  #readOnlyPerms(): Perms[] {
    const { Perms: perms } = this.platform.api.hap
    return [perms.PAIRED_READ, perms.NOTIFY]
  }

  /** Which modes this thermostat's equipment can actually deliver. */
  #supportedTargetStates(): number[] {
    const { Characteristic } = this.platform
    const states = [Characteristic.TargetHeatingCoolingState.OFF]

    // Until Nest reports capabilities, offer the full set rather than freezing
    // on OFF-only (proto3 defaults look like canHeat=false / canCool=false).
    const capabilitiesKnown = this.state.canHeat !== undefined || this.state.canCool !== undefined
    if (!capabilitiesKnown) {
      return [
        Characteristic.TargetHeatingCoolingState.OFF,
        Characteristic.TargetHeatingCoolingState.HEAT,
        Characteristic.TargetHeatingCoolingState.COOL,
        Characteristic.TargetHeatingCoolingState.AUTO,
      ]
    }

    if (this.state.canHeat) {
      states.push(Characteristic.TargetHeatingCoolingState.HEAT)
    }
    if (this.state.canCool) {
      states.push(Characteristic.TargetHeatingCoolingState.COOL)
    }
    if (this.state.canHeat && this.state.canCool) {
      states.push(Characteristic.TargetHeatingCoolingState.AUTO)
    }

    // Degenerate all-false (empty capabilities message) — keep a usable set.
    return states.length > 1
      ? states
      : [
        Characteristic.TargetHeatingCoolingState.OFF,
        Characteristic.TargetHeatingCoolingState.HEAT,
        Characteristic.TargetHeatingCoolingState.COOL,
        Characteristic.TargetHeatingCoolingState.AUTO,
      ]
  }

  #currentHeatingCoolingState(): CharacteristicValue | undefined {
    const { Characteristic } = this.platform
    const byActivity: Record<HvacActivity, number> = {
      idle: Characteristic.CurrentHeatingCoolingState.OFF,
      heating: Characteristic.CurrentHeatingCoolingState.HEAT,
      cooling: Characteristic.CurrentHeatingCoolingState.COOL,
    }

    return this.state.activity === undefined ? undefined : byActivity[this.state.activity]
  }

  #targetHeatingCoolingState(): CharacteristicValue | undefined {
    const { Characteristic } = this.platform
    const byMode: Record<HvacMode, number> = {
      off: Characteristic.TargetHeatingCoolingState.OFF,
      heat: Characteristic.TargetHeatingCoolingState.HEAT,
      cool: Characteristic.TargetHeatingCoolingState.COOL,
      range: Characteristic.TargetHeatingCoolingState.AUTO,
    }

    return this.state.mode === undefined ? undefined : byMode[this.state.mode]
  }

  /**
   * The single setpoint HomeKit asks for.
   *
   * In range mode there are two, and the Home app drives them through the
   * threshold characteristics instead; the midpoint is reported here so the
   * required characteristic still holds something meaningful.
   */
  #targetTemperature(): number | undefined {
    if (this.state.mode === 'range') {
      return midpoint(this.state.targetTemperatureLowC, this.state.targetTemperatureHighC)
    }
    return this.state.targetTemperatureC
  }

  protected describeState(): string {
    const parts: string[] = []

    if (this.state.currentTemperatureC !== undefined) {
      parts.push(`${this.state.currentTemperatureC.toFixed(1)}\u00B0C`)
    }
    if (this.state.mode !== undefined) {
      parts.push(`Mode ${this.state.mode}`)
    }
    if (this.state.activity !== undefined && this.state.activity !== 'idle') {
      const activity = this.state.activity
      parts.push(activity.charAt(0).toUpperCase() + activity.slice(1))
    }
    if (this.state.mode === 'range') {
      const { targetTemperatureLowC: low, targetTemperatureHighC: high } = this.state
      if (low !== undefined && high !== undefined) {
        parts.push(`Target ${low.toFixed(1)}\u2013${high.toFixed(1)}\u00B0C`)
      }
    } else if (this.state.targetTemperatureC !== undefined) {
      parts.push(`Target ${this.state.targetTemperatureC.toFixed(1)}\u00B0C`)
    }
    if (this.state.isEcoActive) {
      parts.push('Eco')
    }

    return parts.length > 0 ? parts.join(', ') : 'No readings yet'
  }
}
