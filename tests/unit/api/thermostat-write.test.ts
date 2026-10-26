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
  applySentWrite,
  buildThermostatSetpointWrite,
  clampSetpoint,
  encodeEcoModeBatchUpdate,
  encodeTargetTemperatureBatchUpdate,
  formatThermostatUpdateLog,
  isSentWriteConfirmed,
} from '../../../src/api/thermostat-write'
import { MAX_SETPOINT_C, MIN_SETPOINT_C } from '../../../src/settings'
import { loadSchemas } from '../../../src/api/protobuf'
import { mergeThermostatState } from '../../../src/state/thermostat-state'
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

  it('keeps COOL standby when turning off a cool-mode dual system', () => {
    const write = buildThermostatSetpointWrite(
      'DEVICE_ABC',
      {
        ...baseState,
        mode: 'cool',
        canHeat: true,
        canCool: true,
        lastHvacMode: 'cool',
        targetTemperatureC: 24,
      },
      { mode: 'off' },
    )
    expect(write.mode).toBe('off')
    expect(write.standbyMode).toBe('cool')
  })

  it('keeps Nest lastHvacMode when already off', () => {
    const write = buildThermostatSetpointWrite(
      'DEVICE_ABC',
      {
        ...baseState,
        mode: 'off',
        lastHvacMode: 'cool',
        canHeat: true,
        canCool: true,
      },
      { targetTemperatureC: 23 },
    )
    expect(write.standbyMode).toBe('cool')
  })

  it('keeps COOL standby after merge when already off', () => {
    const merged = mergeThermostatState(
      {
        ...baseState,
        mode: 'off',
        lastHvacMode: 'cool',
        canHeat: true,
        canCool: true,
      },
      undefined,
    )
    const write = buildThermostatSetpointWrite('DEVICE_ABC', merged, {
      targetTemperatureC: 23,
    })
    expect(write.standbyMode).toBe('cool')
  })

  it('clears Eco when Nest reports eco active', () => {
    const write = buildThermostatSetpointWrite(
      'DEVICE_ABC',
      { ...baseState, isEcoActive: true },
      { targetTemperatureC: 22 },
    )
    expect(write.clearEco).toBe(true)
  })

  // The deadband must never rewrite the bound the user actually moved. Nest's
  // trait always carries both setpoints, so a cool-mode thermostat still holds
  // a heating bound; lowering the cool target below it used to be silently
  // replaced by `heat + 2` and the furnace was told the wrong number.
  describe('setpoint deadband', () => {
    const dualCool: ThermostatState = {
      mode: 'cool',
      targetTemperatureC: 26,
      targetTemperatureLowC: 21,
      targetTemperatureHighC: 26,
      canHeat: true,
      canCool: true,
    }

    it('honours a cool setpoint lowered past the heat bound', () => {
      const write = buildThermostatSetpointWrite('DEVICE_ABC', dualCool, {
        targetTemperatureC: 20,
      })

      expect(write.targetTemperatureCoolC).toBe(20)
      expect(write.targetTemperatureHeatC).toBe(18)
    })

    it('honours the cooling threshold lowered past the heat bound', () => {
      const write = buildThermostatSetpointWrite('DEVICE_ABC', dualCool, {
        targetTemperatureHighC: 20,
      })

      expect(write.targetTemperatureCoolC).toBe(20)
      expect(write.targetTemperatureHeatC).toBe(18)
    })

    it('yields the cool bound when the user raises heat past it', () => {
      const write = buildThermostatSetpointWrite(
        'DEVICE_ABC',
        { ...dualCool, mode: 'heat' },
        { targetTemperatureC: 28 },
      )

      expect(write.targetTemperatureHeatC).toBe(28)
      expect(write.targetTemperatureCoolC).toBe(30)
    })

    it('lowers a REST-only cool setpoint instead of raising it', () => {
      // Legacy REST accounts report a single setpoint and no bounds. Seeding
      // the heat bound from it made "cool harder" move the setpoint upward.
      const write = buildThermostatSetpointWrite(
        'DEVICE_ABC',
        { mode: 'cool', targetTemperatureC: 24 },
        { targetTemperatureC: 22 },
      )

      expect(write.targetTemperatureCoolC).toBe(22)
      expect(write.targetTemperatureHeatC).toBeLessThanOrEqual(22)
    })

    it('clamps a bound above the ceiling instead of sending it', () => {
      const write = buildThermostatSetpointWrite('DEVICE_ABC', baseState, {
        targetTemperatureHighC: 40,
      })

      expect(write.targetTemperatureCoolC).toBe(MAX_SETPOINT_C)
      expect(write.targetTemperatureHeatC).toBeLessThanOrEqual(MAX_SETPOINT_C)
    })

    it('keeps both bounds when a range midpoint is moved', () => {
      const write = buildThermostatSetpointWrite(
        'DEVICE_ABC',
        { ...dualCool, mode: 'range' },
        { targetTemperatureC: 22 },
      )

      expect(write.targetTemperatureHeatC).toBe(19.5)
      expect(write.targetTemperatureCoolC).toBe(24.5)
    })
  })

  describe('a merged patch', () => {
    const rangeState: ThermostatState = { ...baseState, mode: 'range', canCool: true }

    it('keeps explicit range bounds over the single target in range mode', () => {
      const write = buildThermostatSetpointWrite('DEVICE_ABC', rangeState, {
        targetTemperatureC: 23,
        targetTemperatureLowC: 20,
      })

      expect([write.targetTemperatureHeatC, write.targetTemperatureCoolC]).toEqual([20, 26])
    })

    it('applies the single target with a mode change out of range mode', () => {
      const write = buildThermostatSetpointWrite('DEVICE_ABC', rangeState, {
        mode: 'heat',
        targetTemperatureC: 23,
        targetTemperatureLowC: 20,
      })

      expect(write.targetTemperatureHeatC).toBe(23)
    })
  })
})

describe('applySentWrite', () => {
  const sent = {
    resourceId: 'DEVICE_ABC',
    mode: 'cool' as const,
    targetTemperatureHeatC: 20,
    targetTemperatureCoolC: 24,
    standbyMode: 'cool' as const,
    clearEco: true,
  }

  it('shows the sent mode and bounds over the reported state', () => {
    expect(applySentWrite({ ...baseState, isEcoActive: true }, sent)).toMatchObject({
      mode: 'cool',
      lastHvacMode: 'cool',
      targetTemperatureLowC: 20,
      targetTemperatureHighC: 24,
      targetTemperatureC: 24,
      isEcoActive: false,
    })
  })

  it('keeps Eco and uses the heat bound for a heat write that does not clear Eco', () => {
    const write = { ...sent, mode: 'heat' as const, standbyMode: 'heat' as const, clearEco: false }

    expect(applySentWrite({ ...baseState, isEcoActive: true }, write)).toMatchObject({
      targetTemperatureC: 20,
      isEcoActive: true,
    })
  })
})

describe('isSentWriteConfirmed', () => {
  const write = (mode: ThermostatState['mode'] & string, heat = 20, cool = 24) => ({
    resourceId: 'DEVICE_ABC',
    mode,
    targetTemperatureHeatC: heat,
    targetTemperatureCoolC: cool,
    standbyMode: 'heat' as const,
    clearEco: false,
  })

  it.each([
    ['another mode', { ...baseState, mode: 'cool' as const }, write('heat'), false],
    ['off', { ...baseState, mode: 'off' as const }, write('off'), true],
    ['the heat bound', { ...baseState, targetTemperatureLowC: 20.04 }, write('heat'), true],
    ['a different heat bound', { ...baseState, targetTemperatureLowC: 20.5 }, write('heat'), false],
    ['the single heat target', { mode: 'heat' as const, targetTemperatureC: 20 }, write('heat'), true],
    ['the cool bound', { ...baseState, mode: 'cool' as const, targetTemperatureHighC: 24 }, write('cool'), true],
    ['the single cool target', { mode: 'cool' as const, targetTemperatureC: 24 }, write('cool'), true],
    ['both range bounds', { ...baseState, mode: 'range' as const, targetTemperatureLowC: 20, targetTemperatureHighC: 24 }, write('range'), true],
    ['one range bound', { ...baseState, mode: 'range' as const, targetTemperatureLowC: 20 }, write('range'), false],
    ['no reported bound', { mode: 'range' as const }, write('range'), false],
  ])('matches %s', (_label, state: ThermostatState, sentWrite, isConfirmed) => {
    expect(isSentWriteConfirmed(state, sentWrite)).toBe(isConfirmed)
  })
})

describe('clampSetpoint', () => {
  it('confines a setpoint to the range the accessory publishes', () => {
    expect(clampSetpoint(50)).toBe(MAX_SETPOINT_C)
    expect(clampSetpoint(-10)).toBe(MIN_SETPOINT_C)
    expect(clampSetpoint(21.5)).toBe(21.5)
  })

  it('brings Nest\'s own 90 °F ceiling onto the published ceiling', () => {
    // 32.222 °C is Nest's hottest setpoint, and HomeKit can never ask for it:
    // HAP quantizes onto the half-degree grid, so the slider's top position is
    // 32.0 either way. Clamping to the same 32 keeps the write path and the
    // publish path agreeing on what the top of the range means.
    expect(clampSetpoint(32.222)).toBe(MAX_SETPOINT_C)
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

  it('encodes cool→off as active 0 with hvacMode COOL', () => {
    const write = buildThermostatSetpointWrite(
      'DEVICE_ABC',
      {
        ...baseState,
        mode: 'cool',
        canHeat: true,
        canCool: true,
        lastHvacMode: 'cool',
      },
      { mode: 'off' },
    )
    const bytes = encodeTargetTemperatureBatchUpdate(write)
    const root = loadSchemas()
    const NestMessage = root.lookupType('nest.rpc.NestMessage')
    const decoded = NestMessage.toObject(NestMessage.decode(bytes), {
      bytes: Buffer,
      enums: String,
    }) as { set?: Array<{ property?: { value?: Buffer } }> }
    const trait = root.lookupType('nest.trait.hvac.TargetTemperatureSettingsTrait')
    const traitObj = trait.toObject(trait.decode(decoded.set![0].property!.value!), {
      enums: String,
      longs: Number,
    }) as { settings?: { hvacMode?: string }, active?: { value?: number } }

    expect(traitObj.active?.value).toBe(0)
    expect(traitObj.settings?.hvacMode).toBe('COOL')
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

describe('encodeEcoModeBatchUpdate', () => {
  it('encodes Eco ON and OFF without a setpoint trait', () => {
    const root = loadSchemas()
    const NestMessage = root.lookupType('nest.rpc.NestMessage')
    const ecoTrait = root.lookupType('nest.trait.hvac.EcoModeStateTrait')

    for (const [ecoOn, expected] of [[true, 'ON'], [false, 'OFF']] as const) {
      const decoded = NestMessage.toObject(
        NestMessage.decode(encodeEcoModeBatchUpdate('DEVICE_ABC', ecoOn)),
        { enums: String, longs: Number, bytes: Buffer },
      ) as {
        set?: Array<{
          object?: { key?: string }
          property?: { type_url?: string, typeUrl?: string, value?: Buffer }
        }>
      }

      expect(decoded.set).toHaveLength(1)
      expect(decoded.set?.[0]?.object?.key).toBe('eco_mode_state')
      const ecoObj = ecoTrait.toObject(
        ecoTrait.decode(decoded.set![0]!.property!.value!),
        { enums: String },
      ) as { ecoEnabled?: string }
      expect(ecoObj.ecoEnabled).toBe(expected)
    }
  })
})

describe('formatThermostatUpdateLog', () => {
  it('formats mode-aware HomeKit update lines', () => {
    expect(formatThermostatUpdateLog({
      resourceId: 'DEVICE_ABC',
      mode: 'heat',
      targetTemperatureHeatC: 16,
      targetTemperatureCoolC: 27.1,
      standbyMode: 'heat',
      clearEco: false,
    })).toBe('set Heat 16.0°C')

    expect(formatThermostatUpdateLog({
      resourceId: 'DEVICE_ABC',
      mode: 'cool',
      targetTemperatureHeatC: 16,
      targetTemperatureCoolC: 24,
      standbyMode: 'cool',
      clearEco: false,
    })).toBe('set Cool 24.0°C')

    expect(formatThermostatUpdateLog({
      resourceId: 'DEVICE_ABC',
      mode: 'range',
      targetTemperatureHeatC: 16,
      targetTemperatureCoolC: 27.1,
      standbyMode: 'range',
      clearEco: false,
    })).toBe('set Heat/Cool 16.0–27.1°C')

    expect(formatThermostatUpdateLog({
      resourceId: 'DEVICE_ABC',
      mode: 'off',
      targetTemperatureHeatC: 16,
      targetTemperatureCoolC: 27.1,
      standbyMode: 'heat',
      clearEco: false,
    })).toBe('set Off')
  })
})
