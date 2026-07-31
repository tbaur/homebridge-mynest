/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Decoding Observe frames and individual traits.
 */

import {
  decodeFrame,
  decodeTrait,
  loadSchemas,
  readObserveTraitsRequest,
} from '../../../src/api/protobuf'
import {
  buildFrame,
  encodeTrait,
  heatingThermostatTraits,
  protectTraits,
} from '../../helpers/observe-fixtures'

describe('loadSchemas', () => {
  it('resolves the bundled schemas and caches the result', () => {
    expect(loadSchemas()).toBe(loadSchemas())
  })

  it('exposes the StreamBody type the Observe stream uses', () => {
    expect(loadSchemas().lookupType('nest.rpc.StreamBody')).toBeDefined()
  })
})

describe('readObserveTraitsRequest', () => {
  it('reads the request body that subscribes to traits', () => {
    const body = readObserveTraitsRequest()

    expect(Buffer.isBuffer(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
  })
})

describe('decodeFrame', () => {
  it('lifts every trait out of a frame', () => {
    const { traits } = decodeFrame(buildFrame(heatingThermostatTraits('DEVICE_A')))

    expect(traits.map((trait) => trait.key)).toEqual(
      expect.arrayContaining(['target_temperature_settings', 'hvac_control', 'backplate_temperature']),
    )
    expect(traits.every((trait) => trait.resourceId === 'DEVICE_A')).toBe(true)
  })

  it('reports the fully qualified type of each trait', () => {
    const { traits } = decodeFrame(buildFrame(heatingThermostatTraits()))
    const control = traits.find((trait) => trait.key === 'hvac_control')

    expect(control?.typeUrl).toBe('type.nestlabs.com/nest.trait.hvac.HvacControlTrait')
  })

  it('reports a stream-level status when Nest sends one', () => {
    const { status } = decodeFrame(buildFrame([], { code: 7, message: 'permission denied' }))

    expect(status).toEqual({ code: 7, message: 'permission denied' })
  })

  it('returns no traits for a frame it cannot parse', () => {
    // Every Observe connection opens with a resource catalogue in a shape
    // StreamBody does not describe. Throwing here would mean no stream ever
    // gets past its own first frame.
    expect(decodeFrame(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]))).toEqual({ traits: [] })
  })

  it('returns no traits for an empty frame', () => {
    expect(decodeFrame(Buffer.alloc(0)).traits).toEqual([])
  })
})

describe('decodeTrait', () => {
  it('decodes a trait it has a schema for', () => {
    const value = encodeTrait('nest.trait.hvac.DisplaySettingsTrait', { units: 'DEGREES_F' })

    const decoded = decodeTrait({
      resourceId: 'DEVICE_A',
      key: 'display_settings',
      typeUrl: 'type.nestlabs.com/nest.trait.hvac.DisplaySettingsTrait',
      value,
    })

    expect(decoded).toEqual({ units: 'DEGREES_F' })
  })

  it('renders enums by name so callers never depend on tag numbers', () => {
    const decoded = decodeTrait({
      resourceId: 'DEVICE_A',
      key: 'liveness',
      typeUrl: 'type.nestlabs.com/weave.trait.heartbeat.LivenessTrait',
      value: encodeTrait('weave.trait.heartbeat.LivenessTrait', {
        status: 'LIVENESS_DEVICE_STATUS_ONLINE',
      }),
    })

    expect(decoded).toMatchObject({ status: 'LIVENESS_DEVICE_STATUS_ONLINE' })
  })

  it('skips a trait with no vendored schema instead of failing', () => {
    const decoded = decodeTrait({
      resourceId: 'DEVICE_A',
      key: 'invented',
      typeUrl: 'type.nestlabs.com/nest.trait.invented.NotARealTrait',
      value: Buffer.from([0x08, 0x01]),
    })

    expect(decoded).toBeUndefined()
  })

  it('skips a trait with no payload', () => {
    expect(decodeTrait({
      resourceId: 'DEVICE_A',
      key: 'empty',
      typeUrl: 'type.nestlabs.com/nest.trait.hvac.DisplaySettingsTrait',
      value: Buffer.alloc(0),
    })).toBeUndefined()

    expect(decodeTrait({ resourceId: 'DEVICE_A', key: 'empty' })).toBeUndefined()
  })

  it('omits fields the sender left unset', () => {
    // proto3 does not transmit a field at its default, so a heat-only
    // thermostat really does send just `{ canHeat: 1 }`. Decoding with defaults
    // filled in would invent a `canCool: 0` that HomeKit could not distinguish
    // from Nest having said nothing at all.
    const decoded = decodeTrait({
      resourceId: 'DEVICE_A',
      key: 'hvac_equipment_capabilities',
      typeUrl: 'type.nestlabs.com/nest.trait.hvac.HvacEquipmentCapabilitiesTrait',
      value: encodeTrait('nest.trait.hvac.HvacEquipmentCapabilitiesTrait', { canHeat: 1 }),
    })

    expect(decoded).toEqual({ canHeat: 1 })
    expect(decoded).not.toHaveProperty('canCool')
  })

  it('decodes the Protect traits that carry usable state', () => {
    const { traits } = decodeFrame(buildFrame(protectTraits()))
    const battery = traits.find((trait) => trait.key === 'battery')

    expect(decodeTrait(battery!)).toMatchObject({
      replacementIndicator: 'BATTERY_REPLACEMENT_INDICATOR_NOT_AT_ALL',
    })
  })
})
