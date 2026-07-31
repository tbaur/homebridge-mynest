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
 * whose `set` entries carry encoded trait bytes. The encode shape matches the
 * Nest web app / community protobuf path and probe 12 dry-runs; enable
 * `allowThermostatControl` only after a live `--confirm` on your account.
 */

import { randomUUID } from 'node:crypto'
import type { HvacMode, ThermostatState } from '../types/device'
import { MAX_SETPOINT_C, MIN_SETPOINT_C } from '../settings'
import { loadSchemas } from './protobuf'

/** Fully qualified type URL Nest expects inside google.protobuf.Any. */
export const TARGET_TEMPERATURE_SETTINGS_TYPE_URL =
  'type.nestlabs.com/nest.trait.hvac.TargetTemperatureSettingsTrait'

/** Eco clear uses the same BatchUpdateState NestMessage as setpoints. */
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

  let heat = state.targetTemperatureLowC
    ?? state.targetTemperatureC
    ?? 20
  let cool = state.targetTemperatureHighC
    ?? (state.mode === 'cool' ? state.targetTemperatureC : undefined)
    ?? heat + 5

  if (patch.targetTemperatureLowC !== undefined) {
    heat = patch.targetTemperatureLowC
  }
  if (patch.targetTemperatureHighC !== undefined) {
    cool = patch.targetTemperatureHighC
  }
  if (patch.targetTemperatureC !== undefined) {
    const effective = patch.mode ?? state.mode ?? 'heat'
    if (effective === 'cool') {
      cool = patch.targetTemperatureC
    } else if (effective === 'range') {
      const span = Math.max(cool - heat, 2)
      heat = patch.targetTemperatureC - span / 2
      cool = patch.targetTemperatureC + span / 2
    } else {
      heat = patch.targetTemperatureC
    }
  }

  if (cool < heat) {
    cool = heat + 2
  }

  return {
    resourceId,
    mode,
    targetTemperatureHeatC: clampSetpoint(heat),
    targetTemperatureCoolC: clampSetpoint(cool),
    standbyMode,
    clearEco: state.isEcoActive === true,
  }
}

/** Encode a NestMessage suitable for TraitBatchApi/BatchUpdateState. */
export function encodeTargetTemperatureBatchUpdate(write: ThermostatSetpointWrite): Buffer {
  const root = loadSchemas()
  const setpointTrait = root.lookupType('nest.trait.hvac.TargetTemperatureSettingsTrait')
  const ecoTrait = root.lookupType('nest.trait.hvac.EcoModeStateTrait')
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
    const ecoBytes = ecoTrait.encode(ecoTrait.fromObject({
      ecoEnabled: 'OFF',
      ecoModeChangeReason: 'ECO_MODE_CHANGE_REASON_MANUAL',
      updateInfo,
    })).finish()
    set.push({
      object: {
        id: write.resourceId,
        key: 'eco_mode_state',
        uuid: randomUUID(),
      },
      property: {
        type_url: ECO_MODE_STATE_TYPE_URL,
        value: ecoBytes,
      },
    })
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
