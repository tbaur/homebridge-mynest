/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Synthesised Observe frames for tests.
 *
 * Frames are built by encoding against the same vendored schemas the plugin
 * decodes with, so a test exercises the real framing and decode path rather
 * than a hand-written object that happens to match what the parser expects.
 *
 * No data here comes from a real Nest account. The device ids are invented and
 * the readings are chosen to make each assertion obvious.
 */

import protobuf from 'protobufjs'
import { loadSchemas } from '../../src/api/protobuf'

/** One trait to place in a synthesised frame. */
export interface TraitFixture {
  resourceId: string
  key: string
  /** Short protobuf type name, e.g. `nest.trait.hvac.HvacControlTrait`. */
  typeName: string
  /** Payload in the shape the schema expects, before encoding. */
  value?: Record<string, unknown>
  /**
   * Pre-built bytes, for a trait with no vendored schema.
   *
   * Nest streams plenty of these — every Protect safety trait among them — and
   * the plugin has to carry them through classification while refusing to
   * interpret them, so tests need to be able to produce one.
   */
  raw?: Buffer
}

/**
 * Encode one trait payload to the bytes Nest would put on the wire.
 *
 * Uses `fromObject` rather than `create` so enum *names* are converted to their
 * numbers. `create` takes the object as-is, which silently encodes every enum
 * as zero.
 */
export function encodeTrait(typeName: string, value: Record<string, unknown>): Buffer {
  const type = loadSchemas().lookupType(typeName)
  return Buffer.from(type.encode(type.fromObject(value)).finish())
}

/**
 * Build a complete length-delimited Observe frame.
 *
 * Matches what Nest sends: a `StreamBody` serialised with a tag byte and varint
 * length in front, which is the form `decodeFrame` expects.
 */
export function buildFrame(traits: readonly TraitFixture[], status?: { code: number, message?: string }): Buffer {
  const root = loadSchemas()
  const streamBody = root.lookupType('nest.rpc.StreamBody')

  const payload: Record<string, unknown> = {
    message: [{
      get: traits.map((trait) => ({
        object: { id: trait.resourceId, key: trait.key },
        data: {
          property: {
            type_url: `type.nestlabs.com/${trait.typeName}`,
            value: trait.raw ?? encodeTrait(trait.typeName, trait.value ?? {}),
          },
        },
      })),
    }],
  }

  if (status) {
    payload.status = status
  }

  const body = Buffer.from(streamBody.encode(streamBody.create(payload)).finish())
  return frameLengthDelimited(body)
}

/** Prefix a serialised message with the tag byte and varint length Nest uses. */
export function frameLengthDelimited(body: Buffer): Buffer {
  const writer = protobuf.Writer.create()
  writer.uint32(body.length)
  const lengthBytes = Buffer.from(writer.finish())

  return Buffer.concat([Buffer.from([0x00]), lengthBytes, body])
}

/** A thermostat reporting a plain single-setpoint heat call. */
export function heatingThermostatTraits(resourceId = 'DEVICE_TEST_THERMOSTAT'): TraitFixture[] {
  return [
    {
      resourceId,
      key: 'device_identity',
      typeName: 'weave.trait.description.DeviceIdentityTrait',
      value: { serialNumber: 'TSTAT0001', fwVersion: '6.3-5', modelName: { value: 'Nest Thermostat E' } },
    },
    { resourceId, key: 'label', typeName: 'weave.trait.description.LabelSettingsTrait', value: { label: 'Test Thermostat' } },
    {
      resourceId,
      key: 'hvac_equipment_capabilities',
      typeName: 'nest.trait.hvac.HvacEquipmentCapabilitiesTrait',
      value: { canHeat: 1 },
    },
    {
      resourceId,
      key: 'target_temperature_settings',
      typeName: 'nest.trait.hvac.TargetTemperatureSettingsTrait',
      value: {
        active: { value: 1 },
        settings: { hvacMode: 'HEAT', targetTemperatureHeat: { value: 21 } },
      },
    },
    {
      resourceId,
      key: 'hvac_control',
      typeName: 'nest.trait.hvac.HvacControlTrait',
      value: { settings: { isHeating: 1 } },
    },
    {
      resourceId,
      key: 'backplate_temperature',
      typeName: 'nest.trait.sensor.TemperatureTrait',
      value: { temperature: { value: { value: 19.5 } } },
    },
    {
      resourceId,
      key: 'display_settings',
      typeName: 'nest.trait.hvac.DisplaySettingsTrait',
      value: { units: 'DEGREES_C' },
    },
  ]
}

/** A Protect reporting online, on mains power, with a healthy battery. */
export function protectTraits(resourceId = 'DEVICE_TEST_PROTECT'): TraitFixture[] {
  const serialNumber = resourceId.replace(/^DEVICE_/, '')
  return [
    {
      resourceId,
      key: 'device_identity',
      typeName: 'weave.trait.description.DeviceIdentityTrait',
      value: { serialNumber, fwVersion: '5.0rc38' },
    },
    { resourceId, key: 'label', typeName: 'weave.trait.description.LabelSettingsTrait', value: { label: 'Test Protect' } },
    {
      // No schema is vendored for this one, exactly as on the real stream. It
      // is what identifies the device as a Protect, and the plugin must classify
      // on the type alone without pretending to read the payload.
      resourceId,
      key: 'safety_summary',
      typeName: 'nest.trait.product.protect.SafetySummaryTrait',
      raw: Buffer.from([0x0a, 0x02, 0x08, 0x01]),
    },
    {
      resourceId,
      key: 'liveness',
      typeName: 'weave.trait.heartbeat.LivenessTrait',
      value: { status: 'LIVENESS_DEVICE_STATUS_ONLINE' },
    },
    {
      resourceId,
      key: 'wall_power',
      typeName: 'weave.trait.power.PowerSourceTrait',
      value: { present: true, status: 'POWER_SOURCE_STATUS_ACTIVE' },
    },
    {
      resourceId,
      key: 'battery',
      typeName: 'weave.trait.power.BatteryPowerSourceTrait',
      value: { replacementIndicator: 'BATTERY_REPLACEMENT_INDICATOR_NOT_AT_ALL' },
    },
  ]
}

/** A Temperature Sensor reporting a reading and a healthy cell. */
export function temperatureSensorTraits(resourceId = 'DEVICE_TEST_SENSOR'): TraitFixture[] {
  return [
    {
      resourceId,
      key: 'device_identity',
      typeName: 'weave.trait.description.DeviceIdentityTrait',
      value: { serialNumber: 'SENSOR001', modelName: { value: 'KR1' } },
    },
    { resourceId, key: 'label', typeName: 'weave.trait.description.LabelSettingsTrait', value: { label: 'Test Sensor' } },
    {
      resourceId,
      key: 'current_temperature',
      typeName: 'nest.trait.sensor.TemperatureTrait',
      value: { temperature: { value: { value: 18.25 } } },
    },
    {
      resourceId,
      key: 'battery',
      typeName: 'weave.trait.power.BatteryPowerSourceTrait',
      value: { assessedVoltage: { value: 2.95 } },
    },
  ]
}
