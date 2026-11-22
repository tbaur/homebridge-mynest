/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Keeping Google's updated cookies across restarts.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileCookieStore } from '../../../src/api/cookie-store'
import { COOKIE_STATE_FILE, STATE_DIR } from '../../../src/settings'
import { createRecordingLogger } from '../../helpers/logger'
import { TEST_COOKIES } from '../../helpers/sign-in'

describe('FileCookieStore', () => {
  let storagePath: string
  const stateFile = (): string => join(storagePath, STATE_DIR, COOKIE_STATE_FILE)

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'mynest-cookies-'))
  })

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true })
  })

  it('returns nothing before anything was saved', () => {
    expect(new FileCookieStore(storagePath, createRecordingLogger()).load(TEST_COOKIES)).toBeUndefined()
  })

  it('returns what was saved for the same configured cookies', () => {
    const store = new FileCookieStore(storagePath, createRecordingLogger())
    store.save(TEST_COOKIES, 'SID=test-sid; SIDCC=rotated')

    expect(new FileCookieStore(storagePath, createRecordingLogger()).load(TEST_COOKIES))
      .toBe('SID=test-sid; SIDCC=rotated')
  })

  it('ignores saved cookies once new cookies are configured', () => {
    // Pasting fresh cookies into the config must win over the old saved set.
    const store = new FileCookieStore(storagePath, createRecordingLogger())
    store.save(TEST_COOKIES, 'SID=old-sid; SIDCC=rotated')

    expect(store.load('SID=new-sid; HSID=new-hsid')).toBeUndefined()
  })

  it('writes a file only the Homebridge user can read, without the configured cookies in it', () => {
    new FileCookieStore(storagePath, createRecordingLogger()).save(TEST_COOKIES, 'SID=test-sid; SIDCC=rotated')

    expect(statSync(stateFile()).mode & 0o777).toBe(0o600)
    expect(statSync(join(storagePath, STATE_DIR)).mode & 0o777).toBe(0o700)
    expect(readFileSync(stateFile(), 'utf8')).not.toContain(TEST_COOKIES)
  })

  it.each([
    ['not JSON', 'not json'],
    ['the wrong shape', JSON.stringify({ cookies: 42 })],
  ])('falls back to the configured cookies when the file is %s', (_label, contents) => {
    mkdirSync(join(storagePath, STATE_DIR), { recursive: true })
    writeFileSync(stateFile(), contents)
    const log = createRecordingLogger()

    expect(new FileCookieStore(storagePath, log).load(TEST_COOKIES)).toBeUndefined()
    expect(log.warns).toEqual([])
  })

  it('warns once when it cannot save, and keeps going', () => {
    const log = createRecordingLogger()
    const store = new FileCookieStore('/nonexistent/homebridge-storage', log)

    store.save(TEST_COOKIES, 'SID=a')
    store.save(TEST_COOKIES, 'SID=b')

    expect(log.warns).toHaveLength(1)
    expect(log.warns[0]).toContain('sign-in keeps working until Homebridge restarts')
    expect(log.warns[0]).not.toContain('SID=')
  })
})
