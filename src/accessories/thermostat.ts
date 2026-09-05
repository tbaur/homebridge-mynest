/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest thermostat as a HomeKit Thermostat service.
 *
 * Mode and setpoints write through Nest `BatchUpdateState` when
 * `allowThermostatControl` is enabled. Target characteristics keep write
 * permissions either way — stripping them makes the Home app show
 * "No Response" and hide room tiles.
 */

import type { CharacteristicValue, Perms, PlatformAccessory, Service } from 'homebridge'
import { clampSetpoint, formatThermostatUpdateLog } from '../api/thermostat-write'
import {
  MAX_REPORTED_TEMPERATURE_C,
  MAX_SETPOINT_C,
  MIN_REPORTED_TEMPERATURE_C,
  MIN_SETPOINT_C,
  REPORTED_TEMPERATURE_STEP_C,
  SETPOINT_STEP_C,
} from '../settings'
import type { HvacActivity, HvacMode, NestDevice, ThermostatState } from '../types/device'
import type { Logger } from '../utils/logger'
import { sanitizeError } from '../utils/sanitizers'
import type { MyNestPlatform } from '../platform'
import { NestAccessory } from './base'

/** Midpoint of the two setpoints, used for HomeKit's single target in range mode. */
function midpoint(low: number | undefined, high: number | undefined): number | undefined {
  if (low === undefined || high === undefined) {
    return undefined
  }
  return (low + high) / 2
}

/**
 * A Nest setpoint on the grid this accessory publishes.
 *
 * HAP quantizes and clamps whatever it is handed against the characteristic's
 * props, so pushing Nest's raw Celsius leaves HomeKit holding a number the
 * plugin never computed. A thermostat set to Fahrenheit makes that the normal
 * case rather than an edge one: it stores 72 °F as 22.222 °C, and every push
 * lands a quarter degree from what the Nest app shows. Doing the arithmetic
 * here keeps `onGet`, plugin state, and HomeKit's cache on one number.
 *
 * Quantize first and anchor the grid at {@link MIN_SETPOINT_C}, because that is
 * what HAP does with `minStep` and `minValue`.
 */
function toPublishedSetpoint(celsius: number): number {
  const steps = Math.round((celsius - MIN_SETPOINT_C) / SETPOINT_STEP_C)
  return clampSetpoint(steps * SETPOINT_STEP_C + MIN_SETPOINT_C)
}

export class ThermostatAccessory extends NestAccessory<ThermostatState> {
  #service!: Service
  #ecoService: Service | null = null

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
    // Homebridge PlatformAccessory may expose setPrimaryService; Hap Accessory does.
    ;(this.accessory as PlatformAccessory & { setPrimaryService?: (service: Service) => void })
      .setPrimaryService?.(this.#service)

    // Required Thermostat characteristics must never return null from onGet —
    // HomeKit marks the accessory "No Response" and hides room tiles.
    this.#bindRequired(
      Characteristic.CurrentTemperature,
      () => this.state.currentTemperatureC,
      20,
    )
    this.#bindRequired(
      Characteristic.CurrentHeatingCoolingState,
      () => this.#currentHeatingCoolingState(),
      Characteristic.CurrentHeatingCoolingState.OFF,
    )

    // OFF, not HEAT: the fallback is used before Nest reports a mode, and it
    // must be a member of every set #supportedTargetStates() can return. A
    // cool-only unit publishes [OFF, COOL], and HAP rejects (and warns about) a
    // value outside validValues.
    this.#bindRequired(
      Characteristic.TargetHeatingCoolingState,
      () => this.#targetHeatingCoolingState(),
      Characteristic.TargetHeatingCoolingState.OFF,
      {
        write: async (value) => {
          await this.#write({ mode: this.#modeFromHomeKit(value) })
        },
      },
    )

    this.#bindSetpoint(
      Characteristic.TargetTemperature,
      () => this.#targetTemperature(),
      {
        write: async (value) => {
          if (typeof value !== 'number') {
            return
          }
          await this.#write({ targetTemperatureC: value })
        },
      },
    )
    this.#bindSetpoint(
      Characteristic.HeatingThresholdTemperature,
      () => this.state.targetTemperatureLowC,
      {
        write: async (value) => {
          if (typeof value !== 'number') {
            return
          }
          await this.#write({ targetTemperatureLowC: value })
        },
      },
    )
    this.#bindSetpoint(
      Characteristic.CoolingThresholdTemperature,
      () => this.state.targetTemperatureHighC,
      {
        write: async (value) => {
          if (typeof value !== 'number') {
            return
          }
          await this.#write({ targetTemperatureHighC: value })
        },
      },
    )

    // Nest owns what the device's own screen shows; HomeKit is always given
    // Celsius regardless.
    this.#bindRequired(
      Characteristic.TemperatureDisplayUnits,
      () => this.state.displayUnit === 'F'
        ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT
        : Characteristic.TemperatureDisplayUnits.CELSIUS,
      Characteristic.TemperatureDisplayUnits.CELSIUS,
    )

    this.#applyCharacteristicProps()
    this.#bindHumidity()
    this.#bindEcoSwitch()
  }

  protected onServicesMayChange(): void {
    this.#applyCharacteristicProps()
    this.#bindHumidity()
    this.#bindEcoSwitch()
  }

  /**
   * Refresh mode/setpoint props when Nest capabilities arrive after first publish.
   *
   * The opening Observe snapshot often omits equipment capabilities; applying
   * props only at construction would freeze HEAT/COOL/AUTO forever.
   */
  #applyCharacteristicProps(): void {
    const { Characteristic } = this.platform

    // A reading is not a setpoint. Constraining it to the setpoint range would
    // clamp an unheated room's sub-zero reading up to the floor (and log a HAP
    // warning on every push), and the setpoint's half-degree step would round
    // away precision the sensor actually has.
    this.#service.getCharacteristic(Characteristic.CurrentTemperature).setProps({
      minValue: MIN_REPORTED_TEMPERATURE_C,
      maxValue: MAX_REPORTED_TEMPERATURE_C,
      minStep: REPORTED_TEMPERATURE_STEP_C,
    })

    this.#service.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({
      validValues: this.#supportedTargetStates(),
    })

    // Setpoint ranges are owned by #bindSetpoint, which applies them at bind
    // time; repeating them here would be a second place to keep in step.

    this.#service.getCharacteristic(Characteristic.TemperatureDisplayUnits).setProps({
      perms: this.#readOnlyPerms(),
    })
  }

  /**
   * Send a Nest write when control is enabled; otherwise refresh so HomeKit
   * does not keep a slider position Nest never accepted.
   *
   * A refused write and a failed one are different events and must not look
   * alike. Refused means `allowThermostatControl` is off: nothing malfunctioned,
   * the plugin is doing what it was configured to do, so `onSet` resolves and
   * the last good values are pushed back.
   *
   * A write that reached Nest and failed is reported as a HAP communication
   * failure, so the user learns their change was dropped instead of watching a
   * slider spring back for no stated reason — and an automation awaiting the
   * write sees it fail rather than succeed. Safe here only because every
   * characteristic is bound with an `onGet` handler and the deferred refresh
   * pushes a value a tick later: HAP resets the error status on both paths, so
   * the failure cannot settle into a sticky "No Response".
   */
  async #write(patch: Partial<{
    mode: HvacMode
    targetTemperatureC: number
    targetTemperatureLowC: number
    targetTemperatureHighC: number
  }>): Promise<void> {
    try {
      const write = await this.platform.applyThermostatWrite(this.deviceId, this.state, patch)
      if (!write) {
        this.log.warn(
          `${this.identity.name}: ignoring HomeKit change — enable Allow thermostat control in config.`,
        )
        this.#revertHomeKitValues()
        return
      }
      this.log.info(`${this.identity.name}: ${formatThermostatUpdateLog(write)}`)
    } catch (error) {
      this.log.warn(`${this.identity.name}: thermostat update failed: ${sanitizeError(error)}`)
      this.#revertHomeKitValues()

      // `HapStatusError` rather than the Nest error: rethrowing that would put a
      // stack trace in the Homebridge log through HAP's unhandled-error path,
      // and Nest's message is already logged above without the token in it.
      const { HAPStatus, HapStatusError } = this.platform.api.hap
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  }

  /**
   * Push Nest's last known values after a refused or failed write.
   *
   * HAP assigns the HomeKit-requested value *after* `onSet` resolves, so a
   * synchronous `refresh()` inside the handler is overwritten. Defer one tick.
   */
  #revertHomeKitValues(): void {
    setImmediate(() => {
      this.binder.refresh()
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
   * Nest Eco as a Switch — HomeKit's thermostat mode list has no Eco slot.
   *
   * Same pattern as classic homebridge-nest. Writes require
   * `allowThermostatControl`; the switch stays writable either way so Home
   * does not mark the accessory No Response.
   */
  #bindEcoSwitch(): void {
    const { Characteristic, Service: HapService } = this.platform
    if (!this.#ecoService) {
      const byId = (
        this.accessory as PlatformAccessory & {
          getServiceById?: (type: typeof HapService.Switch, subType: string) => Service | undefined
        }
      ).getServiceById?.(HapService.Switch, 'eco')
      this.#ecoService = byId
        ?? this.accessory.getService(HapService.Switch)
        ?? this.accessory.addService(HapService.Switch, 'Eco Mode', 'eco')
      this.#ecoService.setCharacteristic(Characteristic.Name, 'Eco Mode')
    }

    this.binder.bind(
      this.#ecoService,
      Characteristic.On,
      () => this.state.isEcoActive === true,
      {
        write: async (value) => {
          await this.#writeEco(value === true || value === 1)
        },
      },
    )
  }

  async #writeEco(ecoOn: boolean): Promise<void> {
    try {
      const sent = await this.platform.applyEcoWrite(this.deviceId, ecoOn)
      if (!sent) {
        this.log.warn(
          `${this.identity.name}: ignoring HomeKit Eco change — enable Allow thermostat control in config.`,
        )
        this.#revertHomeKitValues()
        return
      }
      this.log.info(
        `${this.identity.name}: ${ecoOn ? 'Updating to Eco' : 'Clearing Eco'}`,
      )
    } catch (error) {
      this.log.warn(`${this.identity.name}: Eco update failed: ${sanitizeError(error)}`)
      this.#revertHomeKitValues()
    }
  }

  /**
   * Bind a required characteristic that must never answer `onGet` with null.
   *
   * Prefer Nest's value, then the last HAP value, then a typed fallback. Refresh
   * still skips undefined Nest readings so we do not push placeholders as if
   * they were live — only `onGet` needs a non-null answer for HomeKit.
   */
  #bindRequired(
    type: Parameters<typeof this.binder.bind>[1],
    read: () => CharacteristicValue | undefined,
    fallback: CharacteristicValue,
    options: { write?: (value: CharacteristicValue) => Promise<void> } = {},
  ): void {
    const characteristic = this.binder.bind(this.#service, type, () => {
      const value = read()
      if (value !== undefined && value !== null) {
        return value
      }
      const current = this.#service.getCharacteristic(type).value
      return current !== undefined && current !== null ? current : fallback
    }, options.write ? { write: options.write } : {})

    if (characteristic.value === null || characteristic.value === undefined) {
      characteristic.updateValue(fallback)
    }
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
    options: { write?: (value: CharacteristicValue) => Promise<void> } = {},
  ): void {
    const characteristic = this.binder.bind(this.#service, type, () => {
      const value = read()
      if (value !== undefined) {
        return toPublishedSetpoint(value)
      }
      const current = this.#service.getCharacteristic(type).value
      return typeof current === 'number'
        && Number.isFinite(current)
        && current >= MIN_SETPOINT_C
        && current <= MAX_SETPOINT_C
        ? current
        : MIN_SETPOINT_C
    }, options.write ? { write: options.write } : {})

    // Correct both bounds; only the floor used to be. `setProps` clamps a
    // cached value into the range itself, but it reports doing so, and Heating
    // Threshold arrives holding HAP's default of 0 °C on every fresh
    // thermostat, so pre-correcting is what keeps that off the log.
    //
    // Push only when the clamp actually moves the value. `updateValue` runs
    // before the props below and is validated against the ones still in force,
    // whose Heating Threshold ceiling is 25 °C, so re-sending an already-legal
    // 30 °C would push it down to 25 instead of leaving it alone.
    const cached = characteristic.value
    if (typeof cached === 'number') {
      const clamped = clampSetpoint(cached)
      if (clamped !== cached) {
        characteristic.updateValue(clamped)
      }
    }

    characteristic.setProps({
      minValue: MIN_SETPOINT_C,
      maxValue: MAX_SETPOINT_C,
      minStep: SETPOINT_STEP_C,
    })
  }

  /** Permissions for a control this plugin does not act on (display units). */
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

  #modeFromHomeKit(value: CharacteristicValue): HvacMode {
    const { Characteristic } = this.platform
    switch (value) {
      case Characteristic.TargetHeatingCoolingState.OFF:
        return 'off'
      case Characteristic.TargetHeatingCoolingState.COOL:
        return 'cool'
      case Characteristic.TargetHeatingCoolingState.AUTO:
        return 'range'
      case Characteristic.TargetHeatingCoolingState.HEAT:
        return 'heat'
      default:
        // HAP validates against validValues before calling onSet, but
        // #supportedTargetStates mutates that set as capabilities arrive. Off is
        // the safe landing for a value delivered inside that window; heat was
        // the most consequential of the four.
        return 'off'
    }
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
