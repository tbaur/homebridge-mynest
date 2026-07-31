/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest BatchUpdateState thermostat encode helpers.
 */

import {
  ECO_MODE_STATE_TYPE_URL,
  TARGET_TEMPERATURE_SETTINGS_TYPE_URL,
  buildThermostatSetpointWrite,
  encodeTargetTemperatureBatchUpdate,
} from '../../../src/api/thermostat-write'
import { loadSchemas } from '../../../src/api/protobuf'
import type { ThermostatState } from '../../../src/types/device'

const baseState: ThermostatState = {
  mode: 'heat',
  targetTemperatureC: 21,
  targetTemperatureLowC: 21,
  targetTemperatureHighC: 26,
  canHeat: true,
  canCool: false,
}

describe('buildThermostatSetpointWrite', () => {
  it('patches the heat setpoint in heat mode', () => {
    const write = buildThermostatSetpointWrite('DEVICE_ABC', baseState, {
      targetTemperatureC: 22.5,
    })

    expect(write.mode).toBe('heat')
    expect(write.targetTemperatureHeatC).toBe(22.5)
    expect(write.targetTemperatureCoolC).toBeGreaterThanOrEqual(write.targetTemperatureHeatC)
    expect(write.clearEco).toBe(false)
  })

  it('maps off to active=false with a standby mode', () => {
    const write = buildThermostatSetpointWrite('DEVICE_ABC', baseState, { mode: 'off' })
    expect(write.mode).toBe('off')
    expect(write.standbyMode).toBe('heat')
  })

  it('clears Eco when Nest reports eco active', () => {
    const write = buildThermostatSetpointWrite(
      'DEVICE_ABC',
      { ...baseState, isEcoActive: true },
      { targetTemperatureC: 22 },
    )
    expect(write.clearEco).toBe(true)
  })
})

describe('encodeTargetTemperatureBatchUpdate', () => {
  it('produces a NestMessage with the target temperature trait', () => {
    const write = buildThermostatSetpointWrite('DEVICE_ABC', baseState, {
      targetTemperatureC: 22,
    })
    const bytes = encodeTargetTemperatureBatchUpdate(write)
    expect(bytes.byteLength).toBeGreaterThan(20)

    const root = loadSchemas()
    const NestMessage = root.lookupType('nest.rpc.NestMessage')
    const decoded = NestMessage.toObject(NestMessage.decode(bytes), {
      enums: String,
      bytes: Buffer,
    }) as {
      set?: Array<{
        object?: { id?: string, key?: string }
        property?: { type_url?: string, typeUrl?: string, value?: Buffer }
      }>
    }

    expect(decoded.set).toHaveLength(1)
    expect(decoded.set?.[0]?.object?.id).toBe('DEVICE_ABC')
    expect(decoded.set?.[0]?.object?.key).toBe('target_temperature_settings')
    const typeUrl = decoded.set?.[0]?.property?.type_url ?? decoded.set?.[0]?.property?.typeUrl
    expect(typeUrl).toBe(TARGET_TEMPERATURE_SETTINGS_TYPE_URL)

    const traitBytes = decoded.set?.[0]?.property?.value
    expect(traitBytes).toBeDefined()
    const raw = Buffer.isBuffer(traitBytes)
      ? traitBytes
      : Buffer.from(traitBytes as unknown as Uint8Array)
    const trait = root.lookupType('nest.trait.hvac.TargetTemperatureSettingsTrait')
    const traitObj = trait.toObject(trait.decode(raw), {
      enums: String,
      longs: Number,
    }) as {
      settings?: { hvacMode?: string, targetTemperatureHeat?: { value?: number } }
      active?: { value?: number }
    }

    expect(traitObj.settings?.hvacMode).toBe('HEAT')
    expect(traitObj.settings?.targetTemperatureHeat?.value).toBeCloseTo(22, 1)
    expect(traitObj.active?.value).toBe(1)
  })

  it('encodes off as active 0 while keeping a standby HVAC mode', () => {
    const write = buildThermostatSetpointWrite('DEVICE_ABC', baseState, { mode: 'off' })
    const bytes = encodeTargetTemperatureBatchUpdate(write)
    const root = loadSchemas()
    const NestMessage = root.lookupType('nest.rpc.NestMessage')
    const decoded = NestMessage.toObject(NestMessage.decode(bytes), {
      bytes: Buffer,
    }) as { set?: Array<{ property?: { value?: Buffer } }> }
    const trait = root.lookupType('nest.trait.hvac.TargetTemperatureSettingsTrait')
    const traitBytes = decoded.set?.[0]?.property?.value
    expect(traitBytes).toBeDefined()
    const traitObj = trait.toObject(trait.decode(traitBytes!), {
      enums: String,
      longs: Number,
    }) as { settings?: { hvacMode?: string }, active?: { value?: number } }

    expect(traitObj.active?.value).toBe(0)
    expect(traitObj.settings?.hvacMode).toBe('HEAT')
  })

  it('prepends eco_mode_state OFF when clearEco is set', () => {
    const write = buildThermostatSetpointWrite(
      'DEVICE_ABC',
      { ...baseState, isEcoActive: true },
      { targetTemperatureC: 22 },
    )
    const bytes = encodeTargetTemperatureBatchUpdate(write)
    const root = loadSchemas()
    const NestMessage = root.lookupType('nest.rpc.NestMessage')
    const decoded = NestMessage.toObject(NestMessage.decode(bytes), {
      enums: String,
      bytes: Buffer,
    }) as {
      set?: Array<{
        object?: { key?: string }
        property?: { type_url?: string, typeUrl?: string, value?: Buffer }
      }>
    }

    expect(decoded.set).toHaveLength(2)
    expect(decoded.set?.[0]?.object?.key).toBe('eco_mode_state')
    const ecoType = decoded.set?.[0]?.property?.type_url ?? decoded.set?.[0]?.property?.typeUrl
    expect(ecoType).toBe(ECO_MODE_STATE_TYPE_URL)

    const ecoBytes = decoded.set?.[0]?.property?.value
    expect(ecoBytes).toBeDefined()
    const ecoTrait = root.lookupType('nest.trait.hvac.EcoModeStateTrait')
    const ecoObj = ecoTrait.toObject(ecoTrait.decode(ecoBytes!), {
      enums: String,
    }) as { ecoEnabled?: string }
    expect(ecoObj.ecoEnabled).toBe('OFF')

    expect(decoded.set?.[1]?.object?.key).toBe('target_temperature_settings')
  })
})
