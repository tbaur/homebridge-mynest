/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Homebridge API doubles for platform lifecycle tests.
 */

import { EventEmitter } from 'node:events'
import { Accessory, Characteristic, Service, uuid } from '@homebridge/hap-nodejs'
import type { API, Logging, PlatformAccessory } from 'homebridge'

const hapPerms = (jest.requireActual('@homebridge/hap-nodejs') as {
  Perms: Record<string, string>
}).Perms

/** A Homebridge `API` double that records register / unregister / update. */
export class FakeHomebridgeApi extends EventEmitter {
  readonly hap = { Service, Characteristic, uuid, Perms: hapPerms }
  readonly platformAccessory = Accessory

  readonly registered: PlatformAccessory[] = []
  readonly unregistered: PlatformAccessory[] = []
  readonly updated: PlatformAccessory[] = []

  registerPlatformAccessories(
    _plugin: string,
    _platform: string,
    accessories: PlatformAccessory[],
  ): void {
    this.registered.push(...accessories)
  }

  unregisterPlatformAccessories(
    _plugin: string,
    _platform: string,
    accessories: PlatformAccessory[],
  ): void {
    this.unregistered.push(...accessories)
  }

  updatePlatformAccessories(accessories: PlatformAccessory[]): void {
    this.updated.push(...accessories)
  }

  asApi(): API {
    return this as unknown as API
  }
}

/** Recording Homebridge logger. */
export function createHomebridgeLogging(): Logging & {
  debugs: string[]
  infos: string[]
  warns: string[]
  errors: string[]
} {
  const debugs: string[] = []
  const infos: string[] = []
  const warns: string[] = []
  const errors: string[] = []

  const log = ((message: string) => {
    infos.push(message)
  }) as Logging & {
    debugs: string[]
    infos: string[]
    warns: string[]
    errors: string[]
  }

  log.debug = (message: string) => {
    debugs.push(message)
  }
  log.info = (message: string) => {
    infos.push(message)
  }
  log.warn = (message: string) => {
    warns.push(message)
  }
  log.error = (message: string) => {
    errors.push(message)
  }
  log.success = (message: string) => {
    infos.push(message)
  }
  log.log = (message: string) => {
    infos.push(message)
  }
  log.debugs = debugs
  log.infos = infos
  log.warns = warns
  log.errors = errors

  return log
}

export { Accessory, Characteristic, Service, uuid }
