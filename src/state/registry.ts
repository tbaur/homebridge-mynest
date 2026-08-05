/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The union of what both transports report about the home.
 *
 * Neither Nest API is a superset of the other. On the account this plugin was
 * built against, REST `app_launch` returned six Protects and no thermostats
 * while the Observe stream returned seven Protects and five thermostats — and
 * REST simultaneously claimed `num_thermostats: "5+"`. Trusting either alone
 * loses devices, so the registry unions them and records which one supplied
 * each device.
 */

import type {
  DeviceIdentity,
  DeviceInventory,
  DeviceKind,
  DeviceSources,
  NestDevice,
} from '../types/device'
import type {
  BucketMap,
  KryptoniteBucket,
  SharedBucket,
  DeviceBucket,
  TopazBucket,
  WhereBucket,
} from '../types/nest'
import {
  classifyResource,
  collectObserveRoomNames,
  resolveDeviceName,
  toDeviceId,
  toResourceId,
  type RoomNames,
} from './classify'
import type { ObserveState } from './observe-state'
import { readProtectState } from './protect-state'
import { readTemperatureSensorState } from './sensor-state'
import {
  mergeThermostatState,
  readComfortSource,
  readThermostatFromObserve,
  readThermostatFromRest,
} from './thermostat-state'
import { readString } from './traits'

/** REST bucket types that identify a device, mapped to what they are. */
const REST_DEVICE_BUCKETS: ReadonlyArray<{ bucket: string, kind: DeviceKind }> = [
  { bucket: 'topaz', kind: 'protect' },
  { bucket: 'kryptonite', kind: 'temperature_sensor' },
  { bucket: 'shared', kind: 'thermostat' },
  { bucket: 'device', kind: 'thermostat' },
]

export interface BuildInventoryOptions {
  observe: ObserveState
  buckets: BucketMap
  /** Device ids the user asked to keep out of HomeKit, already normalised. */
  ignoredDeviceIds: ReadonlySet<string>
  /**
   * When false, Protect smoke/CO and REST occupancy are marked stale (kept in
   * HomeKit but faulted/inactive) even if cached topaz still holds last-known
   * values. Defaults to true.
   */
  restAlarmFeedAvailable?: boolean
}

/**
 * Merge both transports into the device list the platform publishes.
 *
 * Pure: it reads the two state stores and returns a new inventory, so it can
 * be exercised against fixtures without any transport.
 */
export function buildInventory(options: BuildInventoryOptions): DeviceInventory {
  const {
    observe,
    buckets,
    ignoredDeviceIds,
    restAlarmFeedAvailable = true,
  } = options

  const kinds = collectDeviceKinds(observe, buckets)
  const roomNames = mergeRoomNames(collectObserveRoomNames(observe), readRestRoomNames(buckets))
  const comfortTemperatures = readComfortTemperatures(observe, kinds)

  const thermostats = new Map<string, Extract<NestDevice, { identity: { kind: 'thermostat' } }>>()
  const protects = new Map<string, Extract<NestDevice, { identity: { kind: 'protect' } }>>()
  const sensors = new Map<string, Extract<NestDevice, { identity: { kind: 'temperature_sensor' } }>>()

  for (const [deviceId, kind] of kinds) {
    const context = { observe, buckets, deviceId, roomNames, restAlarmFeedAvailable }
    let device: NestDevice

    switch (kind) {
      case 'thermostat':
        device = buildThermostat(context, comfortTemperatures.get(deviceId))
        break
      case 'protect':
        device = buildProtect(context)
        break
      case 'temperature_sensor':
        device = buildTemperatureSensor(context)
        break
    }

    // Match against both the inventory id and the Nest serial (docs promise
    // either). Serial usually equals the id but can differ when Observe's
    // device_identity trait disagrees with the REST bucket key.
    const serial = device.identity.serialNumber?.toUpperCase()
    if (
      ignoredDeviceIds.has(deviceId.toUpperCase())
      || (serial !== undefined && ignoredDeviceIds.has(serial))
    ) {
      continue
    }

    switch (kind) {
      case 'thermostat':
        thermostats.set(deviceId, device as Extract<NestDevice, { identity: { kind: 'thermostat' } }>)
        break
      case 'protect':
        protects.set(deviceId, device as Extract<NestDevice, { identity: { kind: 'protect' } }>)
        break
      case 'temperature_sensor':
        sensors.set(deviceId, device as Extract<NestDevice, { identity: { kind: 'temperature_sensor' } }>)
        break
    }
  }

  return { thermostats, protects, temperatureSensors: sensors }
}

interface BuildContext {
  observe: ObserveState
  buckets: BucketMap
  deviceId: string
  roomNames: RoomNames
  restAlarmFeedAvailable: boolean
}

/**
 * Enumerate every device either transport knows about.
 *
 * A device present on both is listed once, because Observe's `DEVICE_<id>` and
 * the REST bucket id are the same hardware id with a prefix.
 */
function collectDeviceKinds(observe: ObserveState, buckets: BucketMap): Map<string, DeviceKind> {
  const kinds = new Map<string, DeviceKind>()

  for (const resourceId of observe.resourceIds) {
    const kind = classifyResource(resourceId, observe.typeUrls(resourceId))
    if (kind) {
      kinds.set(toDeviceId(resourceId), kind)
    }
  }

  for (const { bucket, kind } of REST_DEVICE_BUCKETS) {
    for (const id of Object.keys(buckets[bucket] ?? {})) {
      // Observe classification wins: it sees the device's real trait set,
      // whereas the REST bucket name is only a hint about what it should be.
      if (!kinds.has(id)) {
        kinds.set(id, kind)
      }
    }
  }

  return kinds
}

/** Room names from the REST `where` buckets, keyed by Nest's `where_id`. */
function readRestRoomNames(buckets: BucketMap): RoomNames {
  const names = new Map<string, string>()

  for (const value of Object.values(buckets.where ?? {})) {
    for (const entry of (value as WhereBucket | null)?.wheres ?? []) {
      // Type-checked, not just truthiness-checked: a non-string name here ends
      // up in `resolveDeviceName`, where `.trim()` throws.
      const whereId = readString(entry, 'where_id')
      const name = readString(entry, 'name')
      if (whereId && name) {
        names.set(whereId, name)
      }
    }
  }

  return names
}

/** Combine both room-name tables; the id namespaces do not overlap. */
function mergeRoomNames(observe: RoomNames, rest: RoomNames): RoomNames {
  return new Map([...rest, ...observe])
}

/**
 * Resolve the temperature each thermostat is actually regulating to.
 *
 * Computed up front because it crosses devices: a thermostat's reading may
 * belong to a Temperature Sensor elsewhere in the inventory.
 */
function readComfortTemperatures(
  observe: ObserveState,
  kinds: ReadonlyMap<string, DeviceKind>,
): Map<string, number> {
  const temperatures = new Map<string, number>()

  for (const [deviceId, kind] of kinds) {
    if (kind !== 'thermostat') {
      continue
    }

    const { sensorResourceId } = readComfortSource(observe, toResourceId(deviceId))
    if (!sensorResourceId) {
      continue
    }

    const sensor = readTemperatureSensorState({
      state: observe,
      resourceId: sensorResourceId,
      kryptonite: undefined,
    })
    if (sensor.temperatureC !== undefined) {
      temperatures.set(deviceId, sensor.temperatureC)
    }
  }

  return temperatures
}

/** Identity fields common to every device, from whichever transport has them. */
function buildIdentity(context: BuildContext, kind: DeviceKind): DeviceIdentity {
  const { observe, buckets, deviceId, roomNames } = context
  const resourceId = toResourceId(deviceId)

  const identityTrait = observe.trait(resourceId, 'device_identity')
  const restBucket = findRestBucket(buckets, deviceId)

  // Every REST-sourced string goes through `readString`. These are raw JSON
  // values that TypeScript only *claims* are strings; a number or object
  // reaching `resolveDeviceName` throws on `.trim()`, and that throw escapes
  // `buildInventory` on every update cycle, so the plugin publishes nothing at
  // all until Nest changes its mind.
  const whereId = readString(observe.trait(resourceId, 'device_located_settings'), 'whereId', 'value')
    ?? readString(restBucket, 'where_id')

  const sources: DeviceSources = {
    observe: observe.resource(resourceId) !== undefined,
    rest: restBucket !== undefined,
  }

  return {
    id: deviceId,
    kind,
    name: resolveDeviceName({
      kind,
      deviceId,
      label: readString(observe.trait(resourceId, 'label'), 'label'),
      description: readString(restBucket, 'description') ?? readString(restBucket, 'name'),
      roomName: whereId ? roomNames.get(whereId) : undefined,
    }),
    sources,
    // `topaz` spells the model `model`; `device` spells it `model_version`.
    model: readString(identityTrait, 'modelName', 'value')
      ?? readString(restBucket, 'model')
      ?? readString(restBucket, 'model_version'),
    serialNumber: readString(identityTrait, 'serialNumber')
      ?? readString(restBucket, 'serial_number')
      ?? deviceId,
    firmwareVersion: readString(identityTrait, 'fwVersion'),
    whereId,
    structureId: readString(restBucket, 'structure_id'),
  }
}

/**
 * Every REST bucket carrying this id, merged into one identity view.
 *
 * A legacy thermostat appears in both `shared` and `device`, and the two carry
 * different halves of its identity: `shared` has only the setpoints and a name,
 * while `where_id`, `serial_number`, `structure_id`, and the model live in
 * `device`. Taking the first match would silently drop the room assignment, so
 * the device would be published as "Thermostat ABCD" instead of "Hallway
 * Thermostat". Earlier buckets win on conflict, matching the previous
 * first-match precedence.
 */
function findRestBucket(buckets: BucketMap, deviceId: string): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined

  for (const { bucket } of REST_DEVICE_BUCKETS) {
    const value = buckets[bucket]?.[deviceId]
    if (value && typeof value === 'object') {
      merged = { ...(value as Record<string, unknown>), ...merged }
    }
  }

  return merged
}

function buildThermostat(
  context: BuildContext,
  comfortTemperatureC: number | undefined,
): Extract<NestDevice, { identity: { kind: 'thermostat' } }> {
  const { observe, buckets, deviceId } = context
  const resourceId = toResourceId(deviceId)

  const fromObserve = observe.resource(resourceId)
    ? readThermostatFromObserve(observe, resourceId, { comfortTemperatureC })
    : undefined

  const fromRest = readThermostatFromRest(
    buckets.shared?.[deviceId] as SharedBucket | undefined,
    buckets.device?.[deviceId] as DeviceBucket | undefined,
  )

  return {
    identity: buildIdentity(context, 'thermostat') as DeviceIdentity & { kind: 'thermostat' },
    state: mergeThermostatState(fromObserve, fromRest),
  }
}

function buildProtect(context: BuildContext): Extract<NestDevice, { identity: { kind: 'protect' } }> {
  const { observe, buckets, deviceId, restAlarmFeedAvailable } = context

  return {
    identity: buildIdentity(context, 'protect') as DeviceIdentity & { kind: 'protect' },
    state: readProtectState({
      state: observe,
      resourceId: toResourceId(deviceId),
      topaz: buckets.topaz?.[deviceId] as TopazBucket | undefined,
      restAlarmFeedAvailable,
    }),
  }
}

function buildTemperatureSensor(
  context: BuildContext,
): Extract<NestDevice, { identity: { kind: 'temperature_sensor' } }> {
  const { observe, buckets, deviceId } = context

  return {
    identity: buildIdentity(context, 'temperature_sensor') as DeviceIdentity & {
      kind: 'temperature_sensor'
    },
    state: readTemperatureSensorState({
      state: observe,
      resourceId: toResourceId(deviceId),
      kryptonite: buckets.kryptonite?.[deviceId] as KryptoniteBucket | undefined,
    }),
  }
}

/** Every device in an inventory, in a stable order, for logging and iteration. */
export function listDevices(inventory: DeviceInventory): NestDevice[] {
  return [
    ...inventory.thermostats.values(),
    ...inventory.protects.values(),
    ...inventory.temperatureSensors.values(),
  ]
}
