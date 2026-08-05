/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Working out what a Nest resource is and what to call it.
 */

import {
  OBSERVE_DEVICE_PREFIX,
  classifyResource,
  collectObserveRoomNames,
  resolveDeviceName,
  toDeviceId,
  toResourceId,
} from '../../../src/state/classify'
import { decodeFrame } from '../../../src/api/protobuf'
import { ObserveState } from '../../../src/state/observe-state'
import { buildFrame } from '../../helpers/observe-fixtures'

describe('device id normalisation', () => {
  it('strips and restores the Observe prefix', () => {
    // Observe reports `DEVICE_18B4300000ACC1AD` for the Protect that REST calls
    // `topaz.18B4300000ACC1AD`. This correspondence is what makes the merge
    // possible at all.
    expect(toDeviceId(`${OBSERVE_DEVICE_PREFIX}18B4300000ACC1AD`)).toBe('18B4300000ACC1AD')
    expect(toResourceId('18B4300000ACC1AD')).toBe('DEVICE_18B4300000ACC1AD')
  })

  it('is idempotent in both directions', () => {
    expect(toDeviceId('18B4300000ACC1AD')).toBe('18B4300000ACC1AD')
    expect(toResourceId('DEVICE_18B4300000ACC1AD')).toBe('DEVICE_18B4300000ACC1AD')
  })
})

describe('classifyResource', () => {
  it('identifies a Protect by its product traits', () => {
    expect(classifyResource('DEVICE_A', [
      'type.nestlabs.com/nest.trait.product.protect.SafetySummaryTrait',
      'type.nestlabs.com/nest.trait.sensor.TemperatureTrait',
    ])).toBe('protect')
  })

  it('identifies a thermostat by its HVAC control trait', () => {
    expect(classifyResource('DEVICE_A', [
      'type.nestlabs.com/nest.trait.hvac.HvacControlTrait',
    ])).toBe('thermostat')
  })

  it('identifies a temperature sensor by elimination', () => {
    expect(classifyResource('DEVICE_A', [
      'type.nestlabs.com/nest.trait.sensor.TemperatureTrait',
    ])).toBe('temperature_sensor')
  })

  it('does not classify a Protect as a thermometer', () => {
    // A Protect carries a temperature trait too, so order is what stops every
    // smoke alarm in the house being published as a thermometer.
    expect(classifyResource('DEVICE_A', [
      'type.nestlabs.com/nest.trait.sensor.TemperatureTrait',
      'type.nestlabs.com/nest.trait.product.protect.SafetySummaryTrait',
    ])).toBe('protect')
  })

  it('ignores resources that are not devices', () => {
    expect(classifyResource('STRUCTURE_1', [
      'type.nestlabs.com/nest.trait.hvac.HvacControlTrait',
    ])).toBeUndefined()
    expect(classifyResource('USER_1', [])).toBeUndefined()
  })

  it('declines to classify a device it does not recognise', () => {
    expect(classifyResource('DEVICE_A', [
      'type.nestlabs.com/nest.trait.security.SomeCameraTrait',
    ])).toBeUndefined()
    expect(classifyResource('DEVICE_A', [])).toBeUndefined()
  })
})

describe('collectObserveRoomNames', () => {
  it('collects room names from the annotation trait', () => {
    const state = new ObserveState()
    state.apply(decodeFrame(buildFrame([{
      resourceId: 'STRUCTURE_1',
      key: 'located_annotations',
      typeName: 'nest.trait.located.LocatedAnnotationsTrait',
      value: {
        annotations: [{ info: { id: { value: 'room-1' }, name: { value: 'Hallway' } } }],
      },
    }])).traits)

    const names = collectObserveRoomNames(state)

    expect(names.get('room-1')).toBe('Hallway')
  })

  it('returns nothing when no resource carries annotations', () => {
    expect(collectObserveRoomNames(new ObserveState()).size).toBe(0)
  })
})

describe('resolveDeviceName hardening', () => {
  it('strips control characters so a device name cannot forge log lines', () => {
    // Names come from the Nest `label` trait or a REST `description`, and
    // Homebridge logs get pasted into public issue trackers.
    const name = resolveDeviceName({
      kind: 'protect',
      deviceId: 'ABCD1234',
      label: 'Kitchen\n[MyNest] ERROR: token revoked, contact evil.example',
    })

    expect(name).not.toContain('\n')
    expect(name).not.toContain('\r')
    expect(name.startsWith('Kitchen')).toBe(true)
  })

  it('caps a name long enough to flood a log line', () => {
    const name = resolveDeviceName({
      kind: 'protect',
      deviceId: 'ABCD1234',
      label: 'x'.repeat(500),
    })

    expect(name.length).toBeLessThanOrEqual(64)
  })

  it('ignores a non-string name rather than throwing on trim', () => {
    // These are raw JSON values that TypeScript only claims are strings. A
    // number reaching `.trim()` threw, and that throw escaped buildInventory on
    // every update cycle, so the plugin published nothing at all.
    const name = resolveDeviceName({
      kind: 'thermostat',
      deviceId: 'ABCD1234',
      label: 12345 as unknown as string,
      description: {} as unknown as string,
      roomName: null as unknown as string,
    })

    expect(name).toBe('Thermostat 1234')
  })

  it('falls back past a name that is only whitespace or control characters', () => {
    expect(resolveDeviceName({
      kind: 'protect',
      deviceId: 'ABCD1234',
      label: '\u0000\u0001  \t ',
      roomName: 'Hallway',
    })).toBe('Hallway Protect')
  })
})

describe('resolveDeviceName', () => {
  it('prefers a name the user typed', () => {
    expect(resolveDeviceName({
      kind: 'protect',
      deviceId: 'ABC123',
      label: 'Nursery Alarm',
      description: 'Upstairs',
      roomName: 'Hallway',
    })).toBe('Nursery Alarm')
  })

  it('falls back to a REST description', () => {
    expect(resolveDeviceName({
      kind: 'protect',
      deviceId: 'ABC123',
      description: 'Garage Protect',
      roomName: 'Hallway',
    })).toBe('Garage Protect')
  })

  it('builds a name from the room when nothing was typed', () => {
    expect(resolveDeviceName({ kind: 'thermostat', deviceId: 'ABC123', roomName: 'Hallway' }))
      .toBe('Hallway Thermostat')
    expect(resolveDeviceName({ kind: 'temperature_sensor', deviceId: 'ABC123', roomName: 'Study' }))
      .toBe('Study Temperature Sensor')
  })

  it('keeps two unnamed devices distinguishable', () => {
    expect(resolveDeviceName({ kind: 'protect', deviceId: '18b4300000acc1ad' }))
      .toBe('Protect C1AD')
    expect(resolveDeviceName({ kind: 'protect', deviceId: '18b4300000acbfbd' }))
      .toBe('Protect BFBD')
  })

  it('ignores whitespace-only names', () => {
    expect(resolveDeviceName({
      kind: 'protect',
      deviceId: 'ABC123',
      label: '   ',
      roomName: 'Hallway',
    })).toBe('Hallway Protect')
  })
})
