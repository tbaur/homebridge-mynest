/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A HomeKit harness built on the real HAP implementation.
 *
 * Accessory tests run against genuine `hap-nodejs` services and characteristics
 * rather than stubs. That matters for this plugin in particular: the bug it
 * exists to avoid is one where `updateValue` appears to work but pushes a stale
 * cached value, and only the real implementation has the cache that made that
 * possible.
 *
 * The `homebridge` package itself is never imported. It pulls in a Matter
 * runtime at load time, and the plugin only depends on its types, which are
 * erased at compile time.
 */

import { Accessory, Characteristic, Service, uuid } from '@homebridge/hap-nodejs'
import type { API, PlatformAccessory } from 'homebridge'
import type { MyNestPlatform } from '../../src/platform'
import type { ResolvedConfig } from '../../src/types/config'

/**
 * HAP declares `Perms` as a `const enum`, which TypeScript refuses to treat as
 * a value even though the module exports a real object at runtime. Reaching for
 * the runtime export keeps the permission strings out of this file.
 */
const hapPerms = (jest.requireActual('@homebridge/hap-nodejs') as {
  Perms: Record<string, string>
}).Perms

/** A `PlatformAccessory` good enough for the accessory classes under test. */
export function createAccessory(displayName: string, id = displayName): PlatformAccessory {
  const accessory = new Accessory(displayName, uuid.generate(id)) as unknown as PlatformAccessory
  accessory.context = {}
  return accessory
}

export function createResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    name: 'MyNest',
    accessToken: 'test-token',
    fieldTest: false,
    allowThermostatControl: false,
    exposeProtectOccupancy: true,
    exposeProtectTemperature: true,
    ignoredDeviceIds: new Set<string>(),
    diagnosticsInterval: 0,
    structuredLogs: false,
    debug: false,
    ...overrides,
  }
}

/**
 * A platform stand-in exposing only what the accessories read from it.
 *
 * Constructing the real platform would start the transports; the accessories
 * only need the HAP namespaces and the resolved config.
 */
export function createPlatformStub(config: Partial<ResolvedConfig> = {}): MyNestPlatform {
  const api = {
    hap: { Service, Characteristic, uuid, Perms: hapPerms },
  } as unknown as API

  return {
    api,
    Service,
    Characteristic,
    resolvedConfig: createResolvedConfig(config),
  } as unknown as MyNestPlatform
}

/**
 * Read a characteristic's cached value, which is what HomeKit would show.
 *
 * The HAP types name each characteristic as its own class, so the parameters
 * are widened here rather than at every call site.
 */
export function readValue(
  accessory: PlatformAccessory,
  serviceType: unknown,
  characteristicType: unknown,
): unknown {
  const service = accessory.getService(serviceType as never)
  return service?.getCharacteristic(characteristicType as never).value
}

/** Whether the accessory publishes a given service at all. */
export function hasService(accessory: PlatformAccessory, serviceType: unknown): boolean {
  return accessory.getService(serviceType as never) !== undefined
}

export { Accessory, Characteristic, Service, uuid }
