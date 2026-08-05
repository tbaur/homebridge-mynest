/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Patch-merge semantics for the Observe stream.
 *
 * Nest sends one snapshot then deltas. Getting the merge wrong is not a subtle
 * bug: replacing state on each frame blanks every trait the patch did not
 * mention, so a thermostat loses its temperature whenever anything else about
 * it changes.
 */

import { decodeFrame } from '../../../src/api/protobuf'
import { MAX_TRACKED_RESOURCES, ObserveState } from '../../../src/state/observe-state'
import { buildFrame, heatingThermostatTraits } from '../../helpers/observe-fixtures'

const traitsOf = (...args: Parameters<typeof buildFrame>) => decodeFrame(buildFrame(...args)).traits

describe('ObserveState', () => {
  it('records every trait from a snapshot', () => {
    const state = new ObserveState()
    state.apply(traitsOf(heatingThermostatTraits('DEVICE_A')))

    expect(state.size).toBe(1)
    expect(state.resourceIds).toEqual(['DEVICE_A'])
    expect(state.trait('DEVICE_A', 'display_settings')).toEqual({ units: 'DEGREES_C' })
  })

  it('keeps traits a later patch does not mention', () => {
    const state = new ObserveState()
    state.apply(traitsOf(heatingThermostatTraits('DEVICE_A')))

    state.apply(traitsOf([{
      resourceId: 'DEVICE_A',
      key: 'hvac_control',
      typeName: 'nest.trait.hvac.HvacControlTrait',
      value: { settings: {} },
    }]))

    expect(state.trait('DEVICE_A', 'backplate_temperature')).toBeDefined()
    expect(state.trait('DEVICE_A', 'target_temperature_settings')).toBeDefined()
  })

  it('overwrites a trait the patch does mention', () => {
    const state = new ObserveState()
    state.apply(traitsOf(heatingThermostatTraits('DEVICE_A')))

    state.apply(traitsOf([{
      resourceId: 'DEVICE_A',
      key: 'backplate_temperature',
      typeName: 'nest.trait.sensor.TemperatureTrait',
      value: { temperature: { value: { value: 25 } } },
    }]))

    expect(state.trait('DEVICE_A', 'backplate_temperature')).toEqual({
      temperature: { value: { value: 25 } },
    })
  })

  it('names the resources a patch actually changed', () => {
    const state = new ObserveState()
    state.apply(traitsOf(heatingThermostatTraits('DEVICE_A')))
    state.apply(traitsOf(heatingThermostatTraits('DEVICE_B')))

    const changed = state.apply(traitsOf([{
      resourceId: 'DEVICE_B',
      key: 'backplate_temperature',
      typeName: 'nest.trait.sensor.TemperatureTrait',
      value: { temperature: { value: { value: 30 } } },
    }]))

    expect([...changed]).toEqual(['DEVICE_B'])
  })

  it('reports no change when a patch repeats what is already known', () => {
    // Nest re-sends unchanged traits on every reconnect. Treating those as
    // changes would push hundreds of redundant HomeKit notifications a minute.
    const state = new ObserveState()
    const snapshot = traitsOf(heatingThermostatTraits('DEVICE_A'))
    state.apply(snapshot)

    expect([...state.apply(snapshot)]).toEqual([])
  })

  it('reports a resource as changed the first time it is seen', () => {
    const state = new ObserveState()

    expect([...state.apply(traitsOf(heatingThermostatTraits('DEVICE_A')))]).toEqual(['DEVICE_A'])
  })

  it('lists the protobuf types a resource reports, without duplicates', () => {
    const state = new ObserveState()
    state.apply(traitsOf(heatingThermostatTraits('DEVICE_A')))

    const urls = state.typeUrls('DEVICE_A')

    expect(urls).toContain('type.nestlabs.com/nest.trait.hvac.HvacControlTrait')
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('remembers a trait it could not decode, so classification still works', () => {
    const state = new ObserveState()
    state.apply([{
      resourceId: 'DEVICE_A',
      key: 'safety_summary',
      typeUrl: 'type.nestlabs.com/nest.trait.product.protect.SafetySummaryTrait',
      value: Buffer.from([0xff, 0xff]),
    }])

    expect(state.hasTrait('DEVICE_A', 'safety_summary')).toBe(true)
    expect(state.trait('DEVICE_A', 'safety_summary')).toBeUndefined()
    expect(state.typeUrls('DEVICE_A')).toHaveLength(1)
  })

  it('reports nothing for a resource it has never seen', () => {
    const state = new ObserveState()

    expect(state.resource('DEVICE_MISSING')).toBeUndefined()
    expect(state.trait('DEVICE_MISSING', 'anything')).toBeUndefined()
    expect(state.hasTrait('DEVICE_MISSING', 'anything')).toBe(false)
    expect(state.typeUrls('DEVICE_MISSING')).toEqual([])
  })

  it('prunes DEVICE resources that left the inventory while keeping structure context', () => {
    const state = new ObserveState()
    state.apply(traitsOf(heatingThermostatTraits('DEVICE_KEEP')))
    state.apply(traitsOf(heatingThermostatTraits('DEVICE_GONE')))
    state.apply([{
      resourceId: 'STRUCTURE_1',
      key: 'structure_info',
      typeUrl: 'type.nestlabs.com/nest.trait.structure.StructureInfoTrait',
      value: Buffer.from([]),
    }])

    const removed = state.retainDeviceResources(new Set(['DEVICE_KEEP']))

    expect(removed).toEqual(['DEVICE_GONE'])
    expect([...state.resourceIds].sort()).toEqual(['DEVICE_KEEP', 'STRUCTURE_1'])
    expect(state.deviceResourceCount).toBe(1)
  })

  it('stops tracking new resources past the cap, and says so once', () => {
    // The key comes from Nest, and pruning only runs after a snapshot settles —
    // whose timer is re-armed by every incoming trait. A stream that never goes
    // quiet would otherwise grow this map without bound.
    const warnings: number[] = []
    const state = new ObserveState((cap) => warnings.push(cap))

    const updates = Array.from({ length: MAX_TRACKED_RESOURCES + 50 }, (_, index) => ({
      resourceId: `DEVICE_${index}`,
      key: 'label',
      typeUrl: 'type.nestlabs.com/weave.trait.description.LabelSettingsTrait',
    }))
    state.apply(updates)

    expect(state.size).toBe(MAX_TRACKED_RESOURCES)
    expect(warnings).toEqual([MAX_TRACKED_RESOURCES])

    // Already-tracked resources keep updating; only new ones are refused.
    const changed = state.apply([{
      resourceId: 'DEVICE_0',
      key: 'label',
      typeUrl: 'type.nestlabs.com/weave.trait.description.LabelSettingsTrait',
      value: Buffer.from([0x01]),
    }])
    expect([...changed]).toEqual(['DEVICE_0'])

    // The warning is one-shot rather than once per dropped resource.
    state.apply([{ resourceId: 'DEVICE_NEW', key: 'label' }])
    expect(warnings).toHaveLength(1)
  })
})
