/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The house-wide Eco switch reducer, as event sequences.
 */

import {
  PENDING_ECO_MAX_MS,
  initialGlobalEcoState,
  reduceGlobalEco,
  type GlobalEcoEvent,
  type GlobalEcoOutcome,
  type GlobalEcoState,
} from '../../../src/state/global-eco-state'

const report = (allEco: boolean, nowMs: number): GlobalEcoEvent => ({ type: 'nest_report', allEco, nowMs })
const sent = (ecoOn: boolean, nowMs: number, startedAtMs = nowMs): GlobalEcoEvent => (
  { type: 'write_sent', ecoOn, startedAtMs, nowMs }
)
const expire: GlobalEcoEvent = { type: 'expire' }

function replay(cachedOn: boolean, events: readonly GlobalEcoEvent[]): {
  state: GlobalEcoState
  outcomes: GlobalEcoOutcome[]
} {
  let state = initialGlobalEcoState(cachedOn)
  const outcomes: GlobalEcoOutcome[] = []
  for (const event of events) {
    const next = reduceGlobalEco(state, event)
    state = next.state
    outcomes.push(next.outcome)
  }
  return { state, outcomes }
}

describe('reduceGlobalEco', () => {
  it.each<[string, boolean, readonly GlobalEcoEvent[], boolean, GlobalEcoOutcome]>([
    ['starts from the cached position', true, [], true, 'unchanged'],
    ['follows Nest with nothing pending', true, [report(false, 0)], false, 'shown'],
    ['shows a sent command at once', false, [report(false, 0), sent(true, 1)], true, 'shown'],
    ['clears pending when Nest matches', false, [sent(true, 0), report(true, 10)], true, 'confirmed'],
    ['holds the command against a partial aggregate', false, [sent(true, 0), report(false, 10)], true, 'held'],
    [
      'expires to the aggregate that arrived during the window',
      false,
      [sent(true, 0), report(false, 10), expire],
      false,
      'expired_to_nest',
    ],
    [
      'expires without a report and leaves the switch alone',
      false,
      [sent(true, 0), expire],
      true,
      'expired_without_report',
    ],
    [
      'a late non-matching report expires the command itself',
      false,
      [sent(true, 0), report(false, PENDING_ECO_MAX_MS)],
      false,
      'expired_to_nest',
    ],
    [
      'a report one millisecond inside the window still holds',
      false,
      [sent(true, 0), report(false, PENDING_ECO_MAX_MS - 1)],
      true,
      'held',
    ],
    [
      'a second toggle expires to the latest Nest aggregate',
      false,
      [report(false, 0), sent(true, 1), sent(false, 2), report(true, 3), expire],
      true,
      'expired_to_nest',
    ],
    [
      'a second toggle with no new report expires to the last report',
      false,
      [report(false, 0), sent(true, 1), sent(false, 2), expire],
      false,
      'expired_to_nest',
    ],
    ['expiring with nothing pending changes nothing', true, [report(true, 0), expire], true, 'unchanged'],
  ])('%s', (_name, cachedOn, events, expectedShown, expectedLast) => {
    const { state, outcomes } = replay(cachedOn, events)

    expect(state.shown).toBe(expectedShown)
    expect(outcomes.at(-1) ?? 'unchanged').toBe(expectedLast)
  })

  it('treats a matching report that arrived during the write as confirmation', () => {
    const { state, outcomes } = replay(false, [report(false, 0), report(true, 15), sent(true, 20, 10)])

    expect(outcomes.at(-1)).toBe('confirmed')
    expect(state).toMatchObject({ shown: true, pending: null })
  })

  it('does not treat a matching report from before the write as confirmation', () => {
    const { state, outcomes } = replay(false, [report(true, 5), sent(true, 20, 10)])

    expect(outcomes.at(-1)).toBe('shown')
    expect(state.pending).toEqual({ ecoOn: true, sentAtMs: 20 })
  })

  it('restarts the window on a second write', () => {
    const { state } = replay(false, [sent(true, 0), sent(false, 30_000), report(true, PENDING_ECO_MAX_MS)])

    expect(state.pending).toEqual({ ecoOn: false, sentAtMs: 30_000 })
    expect(state.shown).toBe(false)
  })

  it('does not treat the cached position as a Nest reading', () => {
    expect(initialGlobalEcoState(true).nestAllEco).toBeUndefined()
  })
})
