/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The logging wrapper that every message passes through.
 */

import { createScopedLogger } from '../../../src/utils/logger'
import { createRecordingLogger } from '../../helpers/logger'

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

describe('createScopedLogger', () => {
  it('passes ordinary messages through to the base logger', () => {
    const base = createRecordingLogger()
    const log = createScopedLogger(base, 'MyNest', false)

    log.info('Connected to Nest')
    log.warn('Something odd')
    log.error('Something broke')

    expect(base.infos).toEqual(['Connected to Nest'])
    expect(base.warns).toEqual(['Something odd'])
    expect(base.errors).toEqual(['Something broke'])
  })

  it('redacts secrets at every level', () => {
    const base = createRecordingLogger()
    const log = createScopedLogger(base, 'MyNest', true)

    log.debug(`token: Basic ${TOKEN}`)
    log.info(`{"access_token":"${TOKEN}"}`)
    log.warn(`cztoken=${TOKEN}`)
    log.error(`Authorization: Bearer ${TOKEN}`)

    expect(base.all()).not.toContain(TOKEN)
  })

  it('redacts values passed alongside the message', () => {
    const base = createRecordingLogger()
    const log = createScopedLogger(base, 'MyNest', true)

    log.info('session', { access_token: TOKEN })

    expect(base.all()).not.toContain(TOKEN)
  })

  it('drops debug output unless debugging is on', () => {
    const base = createRecordingLogger()
    const log = createScopedLogger(base, 'MyNest', false)

    log.debug('per-trait detail')

    expect(base.debugs).toEqual([])
  })

  it('emits debug output when it is on', () => {
    const base = createRecordingLogger()
    const log = createScopedLogger(base, 'MyNest', true)

    log.debug('per-trait detail')

    expect(base.debugs).toEqual(['per-trait detail'])
  })
})
