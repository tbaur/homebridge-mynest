/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Encode Nest BatchUpdateState bodies for thermostat setpoints.
 *
 * Modern Nest thermostats are Observe-only; REST `/v5/put` cannot reach them.
 * Writes go to `TraitBatchApi/BatchUpdateState` as a `nest.rpc.NestMessage`
 * whose `set` entries carry encoded trait bytes. The encode shape was
 * established against a live account with a maintainer-only probe kit that is
 * not part of this repository, so a change here cannot be validated by the unit
 * tests alone. `allowThermostatControl` is off by default for that reason.
 */

import { randomUUID } from 'node:crypto'
import type { HvacMode, ThermostatState } from '../types/device'
import {
  DEFAULT_SETPOINT_C,
  DEFAULT_SETPOINT_SPAN_C,
  MAX_SETPOINT_C,
  MIN_SETPOINT_C,
  MIN_SETPOINT_SPAN_C,
} from '../settings'
import { loadSchemas } from './protobuf'

/** Fully qualified type URL Nest expects inside google.protobuf.Any. */
export const TARGET_TEMPERATURE_SETTINGS_TYPE_URL =
  'type.nestlabs.com/nest.trait.hvac.TargetTemperatureSettingsTrait'

/** Eco set and clear use the same BatchUpdateState NestMessage as setpoints. */
export const ECO_MODE_STATE_TYPE_URL =
  'type.nestlabs.com/nest.trait.hvac.EcoModeStateTrait'

/** One setpoint / mode change ready to encode. */
export interface ThermostatSetpointWrite {
  /** Observe resource id, e.g. `DEVICE_641666…`. */
  readonly resourceId: string
  /** Desired HomeKit-facing mode (`off` clears `active`). */
  readonly mode: HvacMode
  readonly targetTemperatureHeatC: number
  readonly targetTemperatureCoolC: number
  /**
   * Mode Nest keeps in `settings.hvacMode` while the unit is off.
   * Nest never stores OFF there — only `active=0`. May be `range`.
   */
  readonly standbyMode: Exclude<HvacMode, 'off'>
  /**
   * When true, also clear Nest Eco (`eco_mode_state` → OFF) in the same
   * BatchUpdateState. Manual HomeKit changes should leave Eco like the Nest app.
   */
  readonly clearEco: boolean
}

/**
 * Merge a HomeKit-driven patch onto the last Nest thermostat state.
 *
 * Always produces both heat and cool floats: Nest's trait carries the pair
 * even on heat-only equipment, and omitting one can bounce the other bound.
 *
 * The bound the user actually moved is authoritative. When honouring it would
 * cross the other bound, the *untouched* one yields — sending a value the user
 * did not ask for is worse than moving a bound they were not looking at, and
 * the Home app shows their requested number either way.
 */
export function buildThermostatSetpointWrite(
  resourceId: string,
  state: ThermostatState,
  patch: Partial<{
    mode: HvacMode
    targetTemperatureC: number
    targetTemperatureLowC: number
    targetTemperatureHighC: number
  }>,
): ThermostatSetpointWrite {
  const mode = patch.mode ?? state.mode ?? 'heat'
  const standbyMode = resolveStandbyMode(state, patch.mode)
  // Which bound a single-setpoint change lands on. When the unit is off, Nest
  // keeps the real mode in `lastHvacMode`, so `off` must resolve through the
  // standby mode or a cool-only thermostat's target would move its heat bound.
  const effective: HvacMode = mode === 'off' ? standbyMode : mode

  // A cool-mode thermostat reports its single setpoint as the *cool* bound.
  // Seeding `heat` from it would make a request to cool harder read as a
  // request to cross the bounds, and push the setpoint the wrong way.
  let heat = state.targetTemperatureLowC
    ?? (state.mode === 'cool' ? undefined : state.targetTemperatureC)
    ?? DEFAULT_SETPOINT_C
  let cool = state.targetTemperatureHighC
    ?? (state.mode === 'cool' ? state.targetTemperatureC : undefined)
    ?? heat + DEFAULT_SETPOINT_SPAN_C

  let didSetHeat = false
  let didSetCool = false

  if (patch.targetTemperatureLowC !== undefined) {
    heat = patch.targetTemperatureLowC
    didSetHeat = true
  }
  if (patch.targetTemperatureHighC !== undefined) {
    cool = patch.targetTemperatureHighC
    didSetCool = true
  }
  if (patch.targetTemperatureC !== undefined) {
    if (effective === 'cool') {
      cool = patch.targetTemperatureC
      didSetCool = true
    } else if (effective === 'range') {
      const span = Math.max(cool - heat, MIN_SETPOINT_SPAN_C)
      heat = patch.targetTemperatureC - span / 2
      cool = patch.targetTemperatureC + span / 2
      didSetHeat = true
      didSetCool = true
    } else {
      heat = patch.targetTemperatureC
      didSetHeat = true
    }
  }

  // Clamp before enforcing the span, not after. Clamping last could undo the
  // repair: a heat bound at the ceiling pushed cool to ceiling + span, which
  // clamped straight back to the ceiling and produced a zero gap — exactly what
  // MIN_SETPOINT_SPAN_C exists to prevent.
  heat = clampSetpoint(heat)
  cool = clampSetpoint(cool)

  if (cool - heat < MIN_SETPOINT_SPAN_C) {
    if (didSetCool && !didSetHeat) {
      heat = clampSetpoint(cool - MIN_SETPOINT_SPAN_C)
      // The untouched bound hit a limit, so the touched one has to give.
      cool = clampSetpoint(Math.max(cool, heat + MIN_SETPOINT_SPAN_C))
    } else {
      cool = clampSetpoint(heat + MIN_SETPOINT_SPAN_C)
      heat = clampSetpoint(Math.min(heat, cool - MIN_SETPOINT_SPAN_C))
    }
  }

  return {
    resourceId,
    mode,
    targetTemperatureHeatC: heat,
    targetTemperatureCoolC: cool,
    standbyMode,
    clearEco: state.isEcoActive === true,
  }
}

/**
 * Homebridge info line for a successful HomeKit-driven Nest write.
 *
 * Mode-aware so heat updates do not dump the unused cool bound Nest still
 * carries in the trait.
 */
export function formatThermostatUpdateLog(write: ThermostatSetpointWrite): string {
  const heat = `${write.targetTemperatureHeatC.toFixed(1)}\u00B0C`
  const cool = `${write.targetTemperatureCoolC.toFixed(1)}\u00B0C`

  switch (write.mode) {
    case 'off':
      return 'Updating to Off'
    case 'heat':
      return `Updating Heat to ${heat}`
    case 'cool':
      return `Updating Cool to ${cool}`
    case 'range':
      return `Updating Heat/Cool to ${write.targetTemperatureHeatC.toFixed(1)}\u2013${write.targetTemperatureCoolC.toFixed(1)}\u00B0C`
    default: {
      const exhaustive: never = write.mode
      return exhaustive
    }
  }
}

/** Encode Eco on/off for TraitBatchApi/BatchUpdateState (no setpoint change). */
export function encodeEcoModeBatchUpdate(resourceId: string, ecoOn: boolean): Buffer {
  const NestMessage = loadSchemas().lookupType('nest.rpc.NestMessage')
  return Buffer.from(
    NestMessage.encode(NestMessage.fromObject({
      set: [buildEcoModeSetEntry(resourceId, ecoOn)],
    })).finish(),
  )
}

/** Encode a NestMessage suitable for TraitBatchApi/BatchUpdateState. */
export function encodeTargetTemperatureBatchUpdate(write: ThermostatSetpointWrite): Buffer {
  const root = loadSchemas()
  const setpointTrait = root.lookupType('nest.trait.hvac.TargetTemperatureSettingsTrait')
  const NestMessage = root.lookupType('nest.rpc.NestMessage')

  const isOff = write.mode === 'off'
  const hvacMode = (isOff ? write.standbyMode : write.mode).toUpperCase()
  const nowSec = Math.floor(Date.now() / 1000)
  const updateInfo = {
    updateSource: 'DEVICE',
    updatedBy: { value: write.resourceId },
    timestamp: { value: nowSec },
  }

  const setpointObject = {
    settings: {
      hvacMode,
      targetTemperatureHeat: { value: write.targetTemperatureHeatC },
      targetTemperatureCool: { value: write.targetTemperatureCoolC },
      updateInfo,
      originalUpdateInfo: { updatedBy: {}, timestamp: {} },
    },
    active: { value: isOff ? 0 : 1 },
  }

  /** @type {Array<{ object: object, property: object }>} */
  const set: Array<{ object: object, property: object }> = []

  // Clear Eco first so a manual Home change is not overridden by Eco hold.
  if (write.clearEco) {
    set.push(buildEcoModeSetEntry(write.resourceId, false))
  }

  set.push({
    object: {
      id: write.resourceId,
      key: 'target_temperature_settings',
      uuid: randomUUID(),
    },
    property: {
      type_url: TARGET_TEMPERATURE_SETTINGS_TYPE_URL,
      value: setpointTrait.encode(setpointTrait.fromObject(setpointObject)).finish(),
    },
  })

  return Buffer.from(
    NestMessage.encode(NestMessage.fromObject({ set })).finish(),
  )
}

/** One `NestMessage.set` entry that toggles Eco for a device. */
function buildEcoModeSetEntry(resourceId: string, ecoOn: boolean): {
  object: object
  property: object
} {
  const ecoTrait = loadSchemas().lookupType('nest.trait.hvac.EcoModeStateTrait')
  const nowSec = Math.floor(Date.now() / 1000)
  const ecoBytes = ecoTrait.encode(ecoTrait.fromObject({
    ecoEnabled: ecoOn ? 'ON' : 'OFF',
    ecoModeChangeReason: 'ECO_MODE_CHANGE_REASON_MANUAL',
    updateInfo: {
      updateSource: 'DEVICE',
      updatedBy: { value: resourceId },
      timestamp: { value: nowSec },
    },
  })).finish()

  return {
    object: {
      id: resourceId,
      key: 'eco_mode_state',
      uuid: randomUUID(),
    },
    property: {
      type_url: ECO_MODE_STATE_TYPE_URL,
      value: ecoBytes,
    },
  }
}

/**
 * Mode Nest retains in `settings.hvacMode` while `active=0`.
 *
 * Prefer the mode we are leaving, then Nest's last reported hvacMode, then
 * equipment capability. Never invent HEAT on a cool-standby dual system.
 */
function resolveStandbyMode(
  state: ThermostatState,
  patchMode: HvacMode | undefined,
): Exclude<HvacMode, 'off'> {
  if (patchMode === 'off' && state.mode && state.mode !== 'off') {
    return state.mode
  }
  if (state.lastHvacMode) {
    return state.lastHvacMode
  }
  if (state.mode && state.mode !== 'off') {
    return state.mode
  }
  return state.canCool && !state.canHeat ? 'cool' : 'heat'
}

function clampSetpoint(celsius: number): number {
  return Math.min(MAX_SETPOINT_C, Math.max(MIN_SETPOINT_C, celsius))
}
