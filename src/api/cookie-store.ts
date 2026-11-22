/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Keeps the Google cookies that sign-in updates across restarts.
 *
 * The saved cookies are tied to the cookies in the configuration by a
 * fingerprint. Pasting new cookies into the config therefore replaces the
 * saved ones instead of being overridden by them.
 */

import { scryptSync } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { COOKIE_STATE_FILE, STATE_DIR } from '../settings'
import type { Logger } from '../utils/logger'
import type { CookieStore } from './google-auth'

/** Fixed salt for the configured-cookies fingerprint. Not a credential. */
const FINGERPRINT_SALT = 'homebridge-mynest:cookie-source'

interface SavedCookies {
  source: string
  cookies: string
}

function fingerprint(configuredCookies: string): string {
  return scryptSync(configuredCookies, FINGERPRINT_SALT, 16).toString('hex')
}

function isSavedCookies(value: unknown): value is SavedCookies {
  return typeof value === 'object'
    && value !== null
    && 'source' in value
    && typeof value.source === 'string'
    && 'cookies' in value
    && typeof value.cookies === 'string'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** A {@link CookieStore} backed by one owner-only file in the Homebridge storage path. */
export class FileCookieStore implements CookieStore {
  readonly #dir: string
  readonly #file: string
  readonly #log: Logger
  #hasWarned = false

  constructor(storagePath: string, log: Logger) {
    this.#dir = join(storagePath, STATE_DIR)
    this.#file = join(this.#dir, COOKIE_STATE_FILE)
    this.#log = log
  }

  load(configuredCookies: string): string | undefined {
    let text: string
    try {
      text = readFileSync(this.#file, 'utf8')
    } catch (error) {
      if (!isMissingFile(error)) {
        this.#log.debug(`Saved Google cookies could not be read; using the configured ones (${describe(error)})`)
      }
      return undefined
    }

    let saved: unknown
    try {
      saved = JSON.parse(text)
    } catch {
      this.#log.debug('Saved Google cookies are not valid JSON; using the configured ones')
      return undefined
    }

    if (!isSavedCookies(saved) || saved.source !== fingerprint(configuredCookies) || saved.cookies === '') {
      return undefined
    }
    return saved.cookies
  }

  save(configuredCookies: string, cookies: string): void {
    const saved: SavedCookies = { source: fingerprint(configuredCookies), cookies }
    const temp = `${this.#file}.tmp`
    try {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
      writeFileSync(temp, JSON.stringify(saved), { mode: 0o600 })
      chmodSync(temp, 0o600)
      renameSync(temp, this.#file)
      this.#hasWarned = false
    } catch (error) {
      if (!this.#hasWarned) {
        this.#hasWarned = true
        this.#log.warn(
          `Could not save updated Google cookies (${describe(error)}); sign-in keeps working until Homebridge restarts`,
        )
      }
    }
  }
}
