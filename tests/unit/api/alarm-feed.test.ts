/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The Protect alarm-feed freshness decision, as event sequences.
 */

import { AlarmFeedClock, type AlarmFeedConditions, type RestRefresh } from '../../../src/api/alarm-feed'
import {
  REST_ALARM_FEED_STALE_MS,
  REST_PROOF_OF_LIFE_MS,
  REST_RESPONSE_STALE_MS,
  SUBSCRIBE_TIMEOUT_MS,
} from '../../../src/settings'

const HEALTHY: AlarmFeedConditions = {
  isStopped: false,
  isForbiddenDead: false,
  hasLoopExited: false,
  isBreakerClosed: true,
}

/** One REST read at a time offset, or `null` for a read that is not a refresh (truncated app_launch). */
type Step = readonly [atMs: number, refresh: RestRefresh | null]

function replay(steps: readonly Step[]): AlarmFeedClock {
  const clock = new AlarmFeedClock()
  for (const [atMs, refresh] of steps) {
    if (refresh !== null) {
      clock.record(refresh, atMs)
    }
  }
  return clock
}

/** Every subscribe cycle times out unanswered; app_launch runs at each proof interval. */
function quietHouse(untilMs: number, launch: RestRefresh | null): Step[] {
  const steps: Step[] = [[0, 'answered']]
  let nextProof = REST_PROOF_OF_LIFE_MS
  for (let at = SUBSCRIBE_TIMEOUT_MS; at <= untilMs; at += SUBSCRIBE_TIMEOUT_MS) {
    if (at >= nextProof) {
      steps.push([at, launch])
      nextProof = at + REST_PROOF_OF_LIFE_MS
    }
    steps.push([at, 'unanswered'])
  }
  return steps
}

describe('AlarmFeedClock', () => {
  it.each<[string, readonly Step[], number, boolean]>([
    ['nothing recorded yet', [], 0, false],
    ['answered just now', [[0, 'answered']], 0, true],
    ['answered, at the refresh limit', [[0, 'answered']], REST_ALARM_FEED_STALE_MS, true],
    ['answered, one past the refresh limit', [[0, 'answered']], REST_ALARM_FEED_STALE_MS + 1, false],
    ['only unanswered timeouts, never an answer', [[0, 'unanswered']], 0, false],
    [
      'unanswered timeouts keep the refresh clock, answer still recent',
      [[0, 'answered'], [SUBSCRIBE_TIMEOUT_MS, 'unanswered'], [2 * SUBSCRIBE_TIMEOUT_MS, 'unanswered']],
      2 * SUBSCRIBE_TIMEOUT_MS,
      true,
    ],
    [
      'unanswered timeouts cannot outlive the answer clock',
      [[0, 'answered'], [REST_RESPONSE_STALE_MS, 'unanswered']],
      REST_RESPONSE_STALE_MS + 1,
      false,
    ],
    [
      'truncated app_launch is not a refresh',
      [[0, 'answered'], [REST_ALARM_FEED_STALE_MS, null]],
      REST_ALARM_FEED_STALE_MS + 1,
      false,
    ],
  ])('%s', (_name, steps, nowMs, expected) => {
    expect(replay(steps).isLive(nowMs, HEALTHY)).toBe(expected)
  })

  it('stays live on a quiet house whose proof-of-life app_launch is complete', () => {
    const horizon = 60 * 60_000
    const clock = replay(quietHouse(horizon, 'answered'))

    expect(clock.isLive(horizon, HEALTHY)).toBe(true)
  })

  it('goes stale on a quiet house whose proof-of-life app_launch is always truncated', () => {
    const horizon = 60 * 60_000
    const clock = replay(quietHouse(horizon, null))

    expect(clock.isLive(horizon, HEALTHY)).toBe(false)
  })

  it.each<[keyof AlarmFeedConditions, boolean]>([
    ['isStopped', true],
    ['isForbiddenDead', true],
    ['hasLoopExited', true],
    ['isBreakerClosed', false],
  ])('is not live when %s is %s, even right after an answer', (key, value) => {
    const clock = replay([[0, 'answered']])

    expect(clock.isLive(0, { ...HEALTHY, [key]: value })).toBe(false)
  })

  it('expires at whichever clock runs out first', () => {
    expect(new AlarmFeedClock().ageExpiresAt()).toBeNull()
    expect(replay([[0, 'unanswered']]).ageExpiresAt()).toBeNull()

    const answeredOnly = replay([[0, 'answered']])
    expect(answeredOnly.ageExpiresAt()).toBe(REST_ALARM_FEED_STALE_MS + 1)

    const refreshedLater = REST_RESPONSE_STALE_MS - 10
    const answerFirst = replay([[0, 'answered'], [refreshedLater, 'unanswered']])
    expect(answerFirst.ageExpiresAt()).toBe(REST_RESPONSE_STALE_MS + 1)
    expect(answerFirst.isLive(REST_RESPONSE_STALE_MS, HEALTHY)).toBe(true)
    expect(answerFirst.isLive(REST_RESPONSE_STALE_MS + 1, HEALTHY)).toBe(false)
  })
})
