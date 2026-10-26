/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Which Nest conditions are worth a PagerDuty page.
 *
 * The store writer is the copied module. This file owns the house-level OR
 * over every Protect, the grace before a stale alarm feed pages, and which
 * fatal errors mean the plugin has stopped. A device name never enters a
 * summary.
 */

import type { SignalState } from './pagerduty-signals'
import type { AlarmLevel, ProtectState } from './types/device'

/** Logged once, in this order, when the setting is on. */
export const PAGERDUTY_STARTUP_LOG =
  'homebridge-pagerduty support is enabled (smoke, co, alarm-feed-stale, auth-failed)'

export const SIGNAL_SMOKE = 'smoke'
export const SIGNAL_CO = 'co'
export const SIGNAL_ALARM_FEED_STALE = 'alarm-feed-stale'
export const SIGNAL_AUTH_FAILED = 'auth-failed'

/** How long the alarm feed must stay unavailable before it pages. */
export const ALARM_FEED_STALE_GRACE_MS = 5 * 60_000

export const SMOKE_SUMMARY = 'A Nest Protect detects smoke.'
export const CO_SUMMARY = 'A Nest Protect detects carbon monoxide.'
export const ALARM_FEED_STALE_SUMMARY =
  'Nest Protect smoke and CO readings are stale. HomeKit may not show an alarm.'
export const TOKEN_REJECTED_SUMMARY =
  'Nest rejected the access token. This plugin has stopped, so Protect smoke and CO no longer reach HomeKit.'
export const SESSION_FORMAT_SUMMARY =
  'Nest changed its session format. This plugin has stopped, so Protect smoke and CO no longer reach HomeKit.'
export const CONFIG_INVALID_SUMMARY =
  'The Nest access token in Homebridge is missing or invalid. This plugin has stopped, so Protect smoke and CO no longer reach HomeKit.'

/** Why the plugin stopped. The summary depends on it. The signal name does not. */
export type StopReason = 'token' | 'session' | 'config'

const STOP_SUMMARIES: Record<StopReason, string> = {
  token: TOKEN_REJECTED_SUMMARY,
  session: SESSION_FORMAT_SUMMARY,
  config: CONFIG_INVALID_SUMMARY,
}

/** The subset of the store writer this class uses. */
export interface SignalWriter {
  write(signal: string, state: SignalState): void
  close(): void
}

function isAlarming(level: AlarmLevel | undefined): boolean {
  return level === 'warning' || level === 'emergency'
}

/**
 * House-level PagerDuty signals for the Protects and the plugin itself.
 *
 * Smoke and CO are written only while the alarm feed is fresh, so a stale
 * reading neither raises nor clears them. A feed that stays unavailable for
 * the grace period raises alarm-feed-stale instead. Once the plugin stops on
 * a fatal error, auth-failed stays raised and nothing else is written.
 * Shutdown closes the writer and leaves every row as it was.
 */
export class NestSignals {
  readonly #writer: SignalWriter
  readonly #graceMs: number
  #staleTimer: ReturnType<typeof setTimeout> | null = null
  #isFeedStaleRaised = false
  #hasStarted = false
  #hasStopped = false
  #isClosed = false

  constructor(writer: SignalWriter, graceMs = ALARM_FEED_STALE_GRACE_MS) {
    this.#writer = writer
    this.#graceMs = graceMs
  }

  /**
   * Write auth-failed and alarm-feed-stale clear, and start the alarm feed grace.
   *
   * Call once, before the first request. The write lists this plugin in
   * homebridge-pagerduty even if Nest never answers, and the grace timer pages
   * for a feed that is already down at launch. Smoke and CO wait for a fresh
   * feed, so a restart cannot clear a real alarm.
   */
  start(): void {
    if (this.#isClosed || this.#hasStarted || this.#hasStopped) {
      return
    }
    this.#hasStarted = true
    this.#writeAuthFailedClear()
    this.#writeFeedStale(false)
    this.#armStaleTimer()
  }

  /** Nest accepted the token. Clears auth-failed. */
  noteConnected(): void {
    if (this.#isClosed || this.#hasStopped) {
      return
    }
    this.#writeAuthFailedClear()
  }

  /** Record the Protects HomeKit is showing and whether their alarm feed is fresh. */
  update(protects: readonly ProtectState[], isFeedAvailable: boolean): void {
    if (this.#isClosed || this.#hasStopped) {
      return
    }
    if (!isFeedAvailable) {
      this.#armStaleTimer()
      return
    }
    this.#clearStaleTimer()
    this.#isFeedStaleRaised = false
    this.#writeFeedStale(false)
    this.#writer.write(SIGNAL_SMOKE, {
      active: protects.some((protect) => isAlarming(protect.smoke)),
      severity: 'critical',
      summary: SMOKE_SUMMARY,
    })
    this.#writer.write(SIGNAL_CO, {
      active: protects.some((protect) => isAlarming(protect.carbonMonoxide)),
      severity: 'critical',
      summary: CO_SUMMARY,
    })
  }

  /**
   * The plugin stopped and will not recover without a restart.
   *
   * Raises auth-failed and lowers alarm-feed-stale, so the user gets one page
   * that names the fix. Smoke and CO keep their last written value.
   */
  noteStopped(reason: StopReason): void {
    if (this.#isClosed || this.#hasStopped) {
      return
    }
    this.#hasStopped = true
    this.#clearStaleTimer()
    this.#writer.write(SIGNAL_AUTH_FAILED, {
      active: true,
      severity: 'error',
      summary: STOP_SUMMARIES[reason],
    })
    this.#writeFeedStale(false)
  }

  /** Close the store and stop the grace timer. Does not clear any signal. */
  close(): void {
    if (this.#isClosed) {
      return
    }
    this.#isClosed = true
    this.#clearStaleTimer()
    this.#writer.close()
  }

  #writeAuthFailedClear(): void {
    this.#writer.write(SIGNAL_AUTH_FAILED, {
      active: false,
      severity: 'error',
      summary: TOKEN_REJECTED_SUMMARY,
    })
  }

  #writeFeedStale(active: boolean): void {
    this.#writer.write(SIGNAL_ALARM_FEED_STALE, {
      active,
      severity: 'error',
      summary: ALARM_FEED_STALE_SUMMARY,
    })
  }

  #armStaleTimer(): void {
    if (this.#staleTimer !== null || this.#isFeedStaleRaised) {
      return
    }
    // close() and noteStopped() clear this timer, so it never fires after either.
    this.#staleTimer = setTimeout(() => {
      this.#staleTimer = null
      this.#isFeedStaleRaised = true
      this.#writeFeedStale(true)
    }, this.#graceMs)
    this.#staleTimer.unref?.()
  }

  #clearStaleTimer(): void {
    if (this.#staleTimer !== null) {
      clearTimeout(this.#staleTimer)
      this.#staleTimer = null
    }
  }
}
