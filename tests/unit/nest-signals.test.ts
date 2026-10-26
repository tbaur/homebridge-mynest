/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Which Nest conditions raise and clear each PagerDuty signal.
 */

import {
  ALARM_FEED_STALE_GRACE_MS,
  NestSignals,
  SESSION_FORMAT_SUMMARY,
  TOKEN_REJECTED_SUMMARY,
  type SignalWriter,
} from '../../src/nest-signals'
import type { SignalState } from '../../src/pagerduty-signals'
import type { ProtectState } from '../../src/types/device'

const CLEAR: ProtectState = { smoke: 'ok', carbonMonoxide: 'ok', occupancySource: 'auto_away' }

function recordingWriter(): SignalWriter & { latest: Map<string, SignalState>, close: jest.Mock } {
  const latest = new Map<string, SignalState>()
  return {
    latest,
    write: (signal, state) => {
      latest.set(signal, state)
    },
    close: jest.fn(),
  }
}

describe('NestSignals', () => {
  let writer: ReturnType<typeof recordingWriter>
  let signals: NestSignals

  beforeEach(() => {
    jest.useFakeTimers()
    writer = recordingWriter()
    signals = new NestSignals(writer)
  })

  afterEach(() => {
    signals.close()
    jest.useRealTimers()
  })

  it('writes smoke, co and alarm-feed-stale clear once the feed is fresh', () => {
    signals.update([CLEAR, CLEAR], true)

    expect(writer.latest.get('smoke')).toEqual(expect.objectContaining({ active: false, severity: 'critical' }))
    expect(writer.latest.get('co')).toEqual(expect.objectContaining({ active: false, severity: 'critical' }))
    expect(writer.latest.get('alarm-feed-stale')).toEqual(expect.objectContaining({ active: false }))
  })

  it.each(['warning', 'emergency'] as const)('raises smoke and co for a %s on any Protect', (level) => {
    signals.update([CLEAR, { ...CLEAR, smoke: level }], true)
    expect(writer.latest.get('smoke')?.active).toBe(true)
    expect(writer.latest.get('co')?.active).toBe(false)

    signals.update([{ ...CLEAR, carbonMonoxide: level }, CLEAR], true)
    expect(writer.latest.get('smoke')?.active).toBe(false)
    expect(writer.latest.get('co')?.active).toBe(true)
  })

  it('does not raise smoke for a Protect that has no reading yet', () => {
    signals.update([{ occupancySource: 'unavailable_observe_only' }], true)

    expect(writer.latest.get('smoke')?.active).toBe(false)
  })

  it('neither raises nor clears smoke while the feed is stale', () => {
    signals.update([{ ...CLEAR, smoke: 'emergency' }], true)
    signals.update([CLEAR], false)

    expect(writer.latest.get('smoke')?.active).toBe(true)
  })

  it('raises alarm-feed-stale only after the feed stays down for the grace period', () => {
    signals.update([CLEAR], true)
    signals.update([CLEAR], false)

    jest.advanceTimersByTime(ALARM_FEED_STALE_GRACE_MS - 1)
    expect(writer.latest.get('alarm-feed-stale')?.active).toBe(false)

    jest.advanceTimersByTime(1)
    expect(writer.latest.get('alarm-feed-stale')?.active).toBe(true)

    signals.update([CLEAR], true)
    expect(writer.latest.get('alarm-feed-stale')?.active).toBe(false)
  })

  it('does not page for a feed that recovers within the grace period', () => {
    signals.update([CLEAR], false)
    jest.advanceTimersByTime(ALARM_FEED_STALE_GRACE_MS / 2)
    signals.update([CLEAR], true)
    jest.advanceTimersByTime(ALARM_FEED_STALE_GRACE_MS)

    expect(writer.latest.get('alarm-feed-stale')?.active).toBe(false)
  })

  it('pages when the feed never arrives after start', () => {
    signals.start()
    jest.advanceTimersByTime(ALARM_FEED_STALE_GRACE_MS)

    expect(writer.latest.get('alarm-feed-stale')?.active).toBe(true)
  })

  it('writes auth-failed and alarm-feed-stale clear at start, but not smoke or co', () => {
    signals.start()

    expect([...writer.latest.keys()].sort()).toEqual(['alarm-feed-stale', 'auth-failed'])
    expect(writer.latest.get('auth-failed')?.active).toBe(false)
    expect(writer.latest.get('alarm-feed-stale')?.active).toBe(false)
  })

  it('does not clear auth-failed when start runs after a stop', () => {
    signals.noteStopped('config')
    signals.start()

    expect(writer.latest.get('auth-failed')?.active).toBe(true)
  })

  it('clears auth-failed once Nest accepts the token', () => {
    signals.noteConnected()

    expect(writer.latest.get('auth-failed')).toEqual(expect.objectContaining({ active: false, severity: 'error' }))
  })

  it('raises one auth-failed page on a stop and then holds every signal', () => {
    signals.update([{ ...CLEAR, smoke: 'emergency' }], true)
    signals.update([CLEAR], false)
    signals.noteStopped('token')

    expect(writer.latest.get('auth-failed')).toEqual({
      active: true,
      severity: 'error',
      summary: TOKEN_REJECTED_SUMMARY,
    })
    expect(writer.latest.get('alarm-feed-stale')?.active).toBe(false)

    jest.advanceTimersByTime(ALARM_FEED_STALE_GRACE_MS)
    signals.update([CLEAR], true)
    signals.noteConnected()

    expect(writer.latest.get('alarm-feed-stale')?.active).toBe(false)
    expect(writer.latest.get('smoke')?.active).toBe(true)
    expect(writer.latest.get('auth-failed')?.active).toBe(true)
  })

  it('names the session format when that is why the plugin stopped', () => {
    signals.noteStopped('session')
    signals.noteStopped('token')

    expect(writer.latest.get('auth-failed')?.summary).toBe(SESSION_FORMAT_SUMMARY)
  })

  it('keeps the first grace timer when start runs again', () => {
    signals.start()
    jest.advanceTimersByTime(ALARM_FEED_STALE_GRACE_MS / 2)
    signals.start()
    signals.update([CLEAR], false)
    jest.advanceTimersByTime(ALARM_FEED_STALE_GRACE_MS / 2)

    expect(writer.latest.get('alarm-feed-stale')?.active).toBe(true)

    signals.update([CLEAR], false)
    jest.advanceTimersByTime(ALARM_FEED_STALE_GRACE_MS)
    expect(writer.latest.get('alarm-feed-stale')?.active).toBe(true)
  })

  it('closes the writer once and writes nothing after', () => {
    signals.close()
    signals.close()
    signals.start()
    signals.update([{ ...CLEAR, smoke: 'emergency' }], true)
    signals.noteConnected()
    signals.noteStopped('token')

    expect(writer.close).toHaveBeenCalledTimes(1)
    expect(writer.latest.size).toBe(0)
  })
})
