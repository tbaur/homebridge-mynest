/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Runs both Nest transports for the lifetime of the plugin.
 *
 * The two loops are deliberately independent. Observe carries thermostats and
 * is the only place several devices appear at all; REST carries Protect alarm
 * state and battery levels. Either can fail without the other, and a home
 * where one is broken should keep updating through the one that works rather
 * than going dark.
 */

import {
  APP_LAUNCH_BUCKET_TYPES,
  FORBIDDEN_FATAL_THRESHOLD,
  MIN_SUBSCRIBE_CYCLE_MS,
  OBSERVE_STARTUP_WARN_MS,
  RECONNECT_BASE_MS,
  REDISCOVERY_INTERVAL_MS,
  REST_ALARM_FEED_STALE_MS,
  SESSION_REFRESH_MS,
  type NestEndpoints,
} from '../settings'
import {
  AuthenticationError,
  CircuitBreakerError,
  ConfigurationError,
  ForbiddenError,
  NestError,
  RateLimitError,
  isCircuitBreakerFailure,
} from '../errors'
import type { BucketMap, NestSession } from '../types/nest'
import type { TraitUpdate } from './protobuf'
import { decodeFrame } from './protobuf'
import { ObjectList, appLaunch, subscribeOnce } from './rest'
import { openSession } from './session'
import { runObserveSession, type Http2Connect } from './observe'
import type { FetchLike } from './http'
import {
  CircuitBreaker,
  CircuitState,
  type CircuitBreakerStatus,
} from './circuit-breaker'
import type { Logger } from '../utils/logger'
import { computeBackoffMs, sleep, withRetry } from '../utils/retry'
import { sanitizeError } from '../utils/sanitizers'

export interface NestTransportOptions {
  accessToken: string
  endpoints: NestEndpoints
  log: Logger
  /** Called with every trait the Observe stream reports, snapshot or patch. */
  onTraits: (traits: readonly TraitUpdate[]) => void
  /** Called with the full bucket map after any REST change. */
  onBuckets: (buckets: BucketMap) => void
  /**
   * Called when a new Observe connection is about to open.
   *
   * The platform uses this to collect the reconnect device snapshot so
   * Observe-only devices that Nest no longer reports can leave HomeKit.
   */
  onObserveSessionStart?: () => void
  /** Called when a failure is not recoverable and the plugin should give up. */
  onFatal: (error: Error) => void
  /**
   * Called when a transport circuit breaker opens (CLOSED/HALF_OPEN → OPEN).
   * Used by diagnostics to count trips; does not alter loop behaviour.
   */
  onCircuitOpen?: (transport: 'rest' | 'observe') => void
  /**
   * Called when Protect smoke/CO may no longer (or may again) be treated as
   * live from cached REST topaz. The platform forces a Protect refresh so
   * StatusActive / StatusFault update; services are not removed.
   */
  onRestAlarmFeedChange?: (available: boolean) => void
  /**
   * Optional metrics hooks for the opt-in diagnostics collector.
   * All callbacks are fire-and-forget; failures must not reach the loops.
   */
  metrics?: TransportMetrics
  /**
   * When false, skip the fixed 15-minute transport status line (diagnostics
   * owns operator visibility instead). Defaults to true.
   */
  statusHeartbeatEnabled?: boolean
  /** Injected REST breaker (tests); defaults to a fresh instance. */
  restCircuitBreaker?: CircuitBreaker
  /** Injected Observe breaker (tests); defaults to a fresh instance. */
  observeCircuitBreaker?: CircuitBreaker
  fetchImpl?: FetchLike
  connect?: Http2Connect
}

/** Counter hooks used by the platform diagnostics collector. */
export interface TransportMetrics {
  apiRequest?: (
    latencyMs: number,
    ok: boolean,
    options?: boolean | { networked?: boolean, sampleLatency?: boolean },
  ) => void
  sessionLogin?: () => void
  restCycle?: (ok: boolean, durationMs: number) => void
  observeReconnect?: () => void
  retry?: () => void
}

/** What each loop is currently doing, for diagnostics. */
export interface TransportStatus {
  readonly hasSession: boolean
  readonly observeFrames: number
  readonly restCycles: number
  readonly knownObjects: number
  readonly observeState: 'connected' | 'connecting' | 'stopped' | 'forbidden_dead'
  readonly restState: 'running' | 'stopped' | 'forbidden_dead'
  readonly lastObserveFrameAgeSec: number | null
  /**
   * Seconds since the last successful REST cycle (subscribe idle counts).
   * `null` until the first success after start.
   */
  readonly lastRestSuccessAgeSec: number | null
  /**
   * Whether Protect smoke/CO (and REST occupancy) may be treated as live from
   * cached topaz. False when REST is stopped, forbidden-dead, breaker-open,
   * or past {@link REST_ALARM_FEED_STALE_MS} without a success — accessories
   * stay published and are marked inactive/faulted instead.
   */
  readonly isRestAlarmFeedAvailable: boolean
  readonly circuitBreaker: {
    readonly rest: CircuitBreakerStatus
    readonly observe: CircuitBreakerStatus
  }
}

/** Owns the Nest session and both read loops. */
export class NestTransport {
  readonly #options: NestTransportOptions
  readonly #objects = new ObjectList()
  readonly #abort = new AbortController()
  readonly #restBreaker: CircuitBreaker
  readonly #observeBreaker: CircuitBreaker

  #session: NestSession | null = null
  #isStopped = false
  #observeFrames = 0
  #restCycles = 0
  #lastAppLaunchAt = 0
  /** Consecutive HTTP 403s on the Observe loop only. */
  #observeForbidden = 0
  /** Consecutive HTTP 403s on the REST subscribe loop only. */
  #restForbidden = 0
  /** Observe gave up after repeated 403s; REST may still be alive. */
  #observeForbiddenDead = false
  /** REST gave up after repeated 403s; Observe may still be alive. */
  #restForbiddenDead = false
  #didWarnObserveSilent = false
  #statusTimer: NodeJS.Timeout | null = null
  #observeStartupWarnTimer: NodeJS.Timeout | null = null
  #lastObserveFrameAt: number | null = null
  #observeSessionOpen = false
  #restLoopRunning = false
  #lastRestSuccessAt: number | null = null
  #wasRestAlarmFeedAvailable = true
  #restAlarmFeedStaleTimer: NodeJS.Timeout | null = null

  constructor(options: NestTransportOptions) {
    this.#options = options
    this.#restBreaker = options.restCircuitBreaker ?? new CircuitBreaker()
    this.#observeBreaker = options.observeCircuitBreaker ?? new CircuitBreaker()
    this.#wireBreaker(this.#restBreaker, 'rest')
    this.#wireBreaker(this.#observeBreaker, 'observe')
  }

  /** Attach logging + trip callback for one transport breaker. */
  #wireBreaker(breaker: CircuitBreaker, transport: 'rest' | 'observe'): void {
    const label = transport === 'rest' ? 'REST' : 'Observe'
    breaker.attachOnStateChange((from, to) => {
      const message = `Circuit breaker (${label}) ${from} -> ${to}`
      if (to === CircuitState.OPEN) {
        this.#options.log.warn(message)
      } else {
        this.#options.log.info(message)
      }
      if (to === CircuitState.OPEN && from !== CircuitState.OPEN) {
        this.#options.onCircuitOpen?.(transport)
      }
      if (transport === 'rest') {
        this.#emitRestAlarmFeedAvailability()
      }
    })
  }

  get status(): TransportStatus {
    const lastObserveFrameAgeSec = this.#lastObserveFrameAt === null
      ? null
      : Math.round((Date.now() - this.#lastObserveFrameAt) / 1000)
    const lastRestSuccessAgeSec = this.#lastRestSuccessAt === null
      ? null
      : Math.round((Date.now() - this.#lastRestSuccessAt) / 1000)

    return {
      hasSession: this.#session !== null,
      observeFrames: this.#observeFrames,
      restCycles: this.#restCycles,
      knownObjects: this.#objects.size,
      observeState: this.#observeState(),
      restState: this.#restState(),
      lastObserveFrameAgeSec,
      lastRestSuccessAgeSec,
      isRestAlarmFeedAvailable: this.#computeRestAlarmFeedAvailable(),
      circuitBreaker: {
        rest: this.#restBreaker.getStatus(),
        observe: this.#observeBreaker.getStatus(),
      },
    }
  }

  /** Whether cached REST topaz may still be treated as a live Protect alarm feed. */
  #computeRestAlarmFeedAvailable(): boolean {
    if (this.#isStopped || this.#restForbiddenDead) {
      return false
    }
    // Subscribe loop exited after running (not mid-startup before the flag is set).
    if (!this.#restLoopRunning && this.#restCycles > 0) {
      return false
    }
    if (this.#restBreaker.state !== CircuitState.CLOSED) {
      return false
    }
    if (this.#lastRestSuccessAt === null) {
      return false
    }
    return Date.now() - this.#lastRestSuccessAt <= REST_ALARM_FEED_STALE_MS
  }

  #noteRestSuccess(): void {
    this.#lastRestSuccessAt = Date.now()
    this.#armRestAlarmFeedStaleTimer()
    this.#emitRestAlarmFeedAvailability()
  }

  /**
   * Fire {@link #emitRestAlarmFeedAvailability} when the age-based stale window
   * elapses even if the subscribe loop is sleeping through a long backoff.
   */
  #armRestAlarmFeedStaleTimer(): void {
    if (this.#restAlarmFeedStaleTimer) {
      clearTimeout(this.#restAlarmFeedStaleTimer)
      this.#restAlarmFeedStaleTimer = null
    }
    if (this.#lastRestSuccessAt === null) {
      return
    }
    // Feed stays available while age <= STALE (`<=` in #computeRestAlarmFeedAvailable).
    // Fire on the first millisecond past that window so the emit is not a no-op.
    const remainingMs = REST_ALARM_FEED_STALE_MS - (Date.now() - this.#lastRestSuccessAt) + 1
    if (remainingMs <= 0) {
      this.#emitRestAlarmFeedAvailability()
      return
    }
    this.#restAlarmFeedStaleTimer = setTimeout(() => {
      this.#restAlarmFeedStaleTimer = null
      this.#emitRestAlarmFeedAvailability()
    }, remainingMs)
    this.#restAlarmFeedStaleTimer.unref?.()
  }

  #clearRestAlarmFeedStaleTimer(): void {
    if (this.#restAlarmFeedStaleTimer) {
      clearTimeout(this.#restAlarmFeedStaleTimer)
      this.#restAlarmFeedStaleTimer = null
    }
  }

  #emitRestAlarmFeedAvailability(): void {
    const available = this.#computeRestAlarmFeedAvailable()
    if (available === this.#wasRestAlarmFeedAvailable) {
      return
    }
    this.#wasRestAlarmFeedAvailable = available
    this.#options.log.warn(
      available
        ? 'REST alarm feed restored — Protect Smoke/CO live again.'
        : 'REST alarm feed unavailable — Protect Smoke/CO kept, marked inactive.',
    )
    this.#options.onRestAlarmFeedChange?.(available)
  }

  #observeState(): TransportStatus['observeState'] {
    if (this.#observeForbiddenDead) {
      return 'forbidden_dead'
    }
    if (this.#isStopped) {
      return 'stopped'
    }
    if (this.#observeSessionOpen && this.#observeFrames > 0) {
      return 'connected'
    }
    return 'connecting'
  }

  #restState(): TransportStatus['restState'] {
    if (this.#restForbiddenDead) {
      return 'forbidden_dead'
    }
    if (this.#isStopped || !this.#restLoopRunning) {
      return 'stopped'
    }
    return 'running'
  }

  /**
   * Authenticate and take the first full read of the account.
   *
   * Resolves once REST has been enumerated, which is enough to publish
   * accessories; the Observe snapshot follows within a second or two and is
   * pushed as an update rather than being waited for. Blocking on it would
   * delay every REST-visible device behind the slower transport.
   *
   * @throws {AuthenticationError} When the token is rejected. Nothing can
   *   proceed without a session, so this is surfaced rather than retried.
   */
  async start(): Promise<void> {
    this.#session = await this.#openSession()
    await this.#runAppLaunch()

    void this.#runObserveLoop()
    void this.#runSubscribeLoop()
    if (this.#options.statusHeartbeatEnabled !== false) {
      this.#startStatusHeartbeat()
    }
    this.#scheduleObserveStartupWarn()
  }

  /** Stop both loops and release the session. */
  stop(): void {
    this.#isStopped = true
    this.#observeSessionOpen = false
    this.#restLoopRunning = false
    this.#abort.abort()
    this.#session = null
    if (this.#statusTimer) {
      clearInterval(this.#statusTimer)
      this.#statusTimer = null
    }
    if (this.#observeStartupWarnTimer) {
      clearTimeout(this.#observeStartupWarnTimer)
      this.#observeStartupWarnTimer = null
    }
    this.#clearRestAlarmFeedStaleTimer()
    this.#emitRestAlarmFeedAvailability()
  }

  async #openSession(): Promise<NestSession> {
    const startedAt = Date.now()
    try {
      const session = await withRetry(
        () => openSession({
          accessToken: this.#options.accessToken,
          endpoints: this.#options.endpoints,
          log: this.#options.log,
          fetchImpl: this.#options.fetchImpl,
          signal: this.#abort.signal,
        }),
        {
          onRetry: (attempt, delayMs, error) => {
            this.#options.metrics?.retry?.()
            this.#options.log.debug(
              `Session open attempt ${attempt} failed (${sanitizeError(error)}); retrying in ${delayMs}ms`,
            )
          },
        },
      )
      this.#options.metrics?.sessionLogin?.()
      this.#options.metrics?.apiRequest?.(Date.now() - startedAt, true)
      return session
    } catch (error) {
      this.#options.metrics?.apiRequest?.(Date.now() - startedAt, false)
      throw error
    }
  }

  /**
   * Re-open the session when it has aged out or been rejected.
   *
   * Nest reports a long `expires_in`, but a token revoked server-side keeps
   * being accepted until the first refusal, so age alone is not a reliable
   * signal and both triggers are needed.
   */
  async #ensureSession(options: { force?: boolean } = {}): Promise<NestSession> {
    const isStale = this.#session !== null
      && Date.now() - this.#session.openedAt > SESSION_REFRESH_MS

    if (!this.#session || isStale || options.force) {
      this.#options.log.debug('Refreshing the Nest session')
      this.#session = await this.#openSession()
    }

    return this.#session
  }

  /** Pull the whole account and publish it. */
  async #runAppLaunch(): Promise<void> {
    const session = await this.#ensureSession()
    const startedAt = Date.now()

    try {
      const objects = await this.#restBreaker.execute(
        () => withRetry(
          () => appLaunch({
            session,
            endpoints: this.#options.endpoints,
            bucketTypes: APP_LAUNCH_BUCKET_TYPES,
            fetchImpl: this.#options.fetchImpl,
            signal: this.#abort.signal,
          }),
          {
            onRetry: (attempt, delayMs, error) => {
              this.#options.metrics?.retry?.()
              this.#options.log.debug(
                `app_launch attempt ${attempt} failed (${sanitizeError(error)}); retrying in ${delayMs}ms`,
              )
            },
          },
        ),
        { isFailure: isCircuitBreakerFailure },
      )

      this.#lastAppLaunchAt = Date.now()
      const snapshot = this.#objects.applyAppLaunchSnapshot(objects)
      if (snapshot.truncated) {
        this.#options.log.warn(
          `app_launch incomplete (${objects.length} objects, had ${snapshot.previousCount}) — keeping prior REST state`,
        )
      } else if (snapshot.dropped.length > 0) {
        this.#options.log.info(
          `REST dropped ${snapshot.dropped.length} object(s) from inventory`,
        )
      }
      this.#options.onBuckets(this.#objects.toBuckets())
      this.#options.metrics?.apiRequest?.(Date.now() - startedAt, true)
      this.#options.metrics?.restCycle?.(true, Date.now() - startedAt)
      this.#noteRestSuccess()
    } catch (error) {
      const networked = !(error instanceof CircuitBreakerError)
      this.#options.metrics?.apiRequest?.(Date.now() - startedAt, false, networked)
      this.#options.metrics?.restCycle?.(false, Date.now() - startedAt)
      this.#emitRestAlarmFeedAvailability()
      throw error
    }
  }

  /**
   * Keep an Observe stream running for as long as the plugin does.
   *
   * Every exit from a single connection is expected at some point — Nest
   * recycles them, the network drops, a stream goes quiet — so the loop treats
   * a clean end and a failure the same way and simply reconnects. Only a
   * rejected token stops it.
   */
  async #runObserveLoop(): Promise<void> {
    let consecutiveFailures = 0
    let isFirstSession = true

    while (!this.#isStopped) {
      try {
        const session = await this.#ensureSession()
        this.#observeSessionOpen = true
        if (!isFirstSession) {
          this.#options.metrics?.observeReconnect?.()
        }
        isFirstSession = false
        this.#options.onObserveSessionStart?.()

        const result = await this.#observeBreaker.execute(
          () => runObserveSession({
            session,
            endpoints: this.#options.endpoints,
            log: this.#options.log,
            connect: this.#options.connect,
            signal: this.#abort.signal,
            onFrame: (frame) => this.#handleObserveFrame(frame),
          }),
          { isFailure: isCircuitBreakerFailure },
        )

        this.#observeSessionOpen = false

        if (result.reason === 'aborted') {
          return
        }

        // Any frame at all means the credentials and framing are sound, so a
        // later reconnect should not inherit the previous backoff.
        if (result.frameCount > 0) {
          consecutiveFailures = 0
          this.#observeForbidden = 0
        }

        this.#options.log.debug(
          `Observe stream ended (${result.reason}) after ${result.frameCount} frame(s) in ${Math.round(result.durationMs / 1000)}s`,
        )
      } catch (error) {
        this.#observeSessionOpen = false
        if (this.#isStopped) {
          return
        }
        if (!(await this.#handleLoopError('Observe stream', error, 'observe'))) {
          return
        }
        if (!(error instanceof CircuitBreakerError)) {
          consecutiveFailures++
        }
        if (!(await this.#waitBeforeReconnect(consecutiveFailures, error))) {
          return
        }
        continue
      }

      if (!(await this.#waitBeforeReconnect(consecutiveFailures))) {
        return
      }
    }
  }

  #handleObserveFrame(frame: Buffer): void {
    this.#observeFrames++
    this.#lastObserveFrameAt = Date.now()

    const { traits, status } = decodeFrame(frame)

    // The first frame of every connection is a resource catalogue in a shape
    // `StreamBody` does not describe, so an empty decode is routine rather
    // than a problem worth reporting.
    if (status?.code !== undefined && status.code !== 0) {
      this.#options.log.debug(
        `Observe stream reported status ${status.code}${status.message ? `: ${status.message}` : ''}`,
      )
    }

    if (traits.length > 0) {
      this.#options.onTraits(traits)
    }
  }

  /**
   * Long-poll REST for changes, re-enumerating the account periodically.
   *
   * The long-poll only reports buckets the client already knows about, so it
   * can never reveal a newly added device. That is what the periodic
   * `app_launch` is for.
   */
  async #runSubscribeLoop(): Promise<void> {
    let consecutiveFailures = 0
    this.#restLoopRunning = true

    while (!this.#isStopped) {
      // Re-check before each attempt so an age-based stale flip during backoff
      // still notifies the platform even if the timer was cleared somehow.
      this.#emitRestAlarmFeedAvailability()
      const cycleStartedAt = Date.now()

      try {
        if (Date.now() - this.#lastAppLaunchAt >= REDISCOVERY_INTERVAL_MS) {
          await this.#runAppLaunch()
        }

        const session = await this.#ensureSession()
        const result = await this.#restBreaker.execute(
          () => subscribeOnce({
            session,
            endpoints: this.#options.endpoints,
            objects: this.#objects.objects,
            fetchImpl: this.#options.fetchImpl,
            signal: this.#abort.signal,
          }),
          { isFailure: isCircuitBreakerFailure },
        )

        this.#restCycles++
        consecutiveFailures = 0
        this.#restForbidden = 0
        // Subscribe is a long-poll by design (idle or not). Never fold its wait
        // into API latency percentiles — session/app_launch remain the samples.
        this.#options.metrics?.apiRequest?.(Date.now() - cycleStartedAt, true, {
          sampleLatency: false,
        })
        this.#options.metrics?.restCycle?.(true, Date.now() - cycleStartedAt)
        this.#noteRestSuccess()

        if (!result.isIdle) {
          this.#objects.merge(result.objects)
          this.#options.onBuckets(this.#objects.toBuckets())
        }
      } catch (error) {
        if (this.#isStopped) {
          this.#restLoopRunning = false
          return
        }
        const networked = !(error instanceof CircuitBreakerError)
        this.#options.metrics?.apiRequest?.(Date.now() - cycleStartedAt, false, {
          networked,
          sampleLatency: false,
        })
        this.#options.metrics?.restCycle?.(false, Date.now() - cycleStartedAt)
        this.#emitRestAlarmFeedAvailability()
        if (!(await this.#handleLoopError('REST subscribe', error, 'rest'))) {
          this.#restLoopRunning = false
          this.#emitRestAlarmFeedAvailability()
          return
        }
        if (!(error instanceof CircuitBreakerError)) {
          consecutiveFailures++
        }

        if (!(await this.#waitBeforeReconnect(consecutiveFailures, error))) {
          this.#restLoopRunning = false
          return
        }
        continue
      }

      // Success path (including idle / converted 502) must still rate-limit.
      // Without this floor a Nest edge outage turns every install into an
      // unthrottled request loop.
      const elapsed = Date.now() - cycleStartedAt
      if (elapsed < MIN_SUBSCRIBE_CYCLE_MS) {
        await sleep(MIN_SUBSCRIBE_CYCLE_MS - elapsed)
      }
    }
  }

  /**
   * Decide whether a loop can carry on after a failure.
   *
   * HTTP 403 counters are per-transport. A WAF blip on REST must not tear down
   * a healthy Observe stream (and vice versa). Only when *both* loops have
   * exhausted their 403 budget does the plugin treat the token as dead.
   *
   * @returns `false` when the loop must stop, having already reported why.
   */
  async #handleLoopError(
    context: string,
    error: unknown,
    transport: 'observe' | 'rest',
  ): Promise<boolean> {
    if (this.#abort.signal.aborted) {
      return false
    }

    if (error instanceof AuthenticationError || error instanceof ConfigurationError) {
      this.#options.onFatal(error)
      return false
    }

    // Fail-fast cooldown: do not force a session refresh or treat this as a
    // Nest HTTP failure — the transport simply waits out the breaker.
    if (error instanceof CircuitBreakerError) {
      this.#options.log.debug(`${context}: ${sanitizeError(error)}`)
      return true
    }

    if (error instanceof ForbiddenError) {
      const count = transport === 'observe'
        ? ++this.#observeForbidden
        : ++this.#restForbidden
      this.#options.log.warn(
        `${context} returned HTTP 403 (${count}/${FORBIDDEN_FATAL_THRESHOLD}): ${sanitizeError(error)}`,
      )
      if (count >= FORBIDDEN_FATAL_THRESHOLD) {
        if (transport === 'observe') {
          this.#observeForbiddenDead = true
        } else {
          this.#restForbiddenDead = true
        }

        if (this.#observeForbiddenDead && this.#restForbiddenDead) {
          this.#options.onFatal(new AuthenticationError(
            `Nest returned HTTP 403 on both REST and Observe ${FORBIDDEN_FATAL_THRESHOLD} times — token may be revoked; get a fresh one from https://home.nest.com/session.`,
            { cause: error },
          ))
        } else {
          this.#options.log.error(
            `${context} giving up after ${count} HTTP 403s — other transport keeps running if it can.`,
          )
        }
        return false
      }
    } else {
      this.#options.log.debug(`${context} failed: ${sanitizeError(error)}`)
    }

    // A rejected session shows up as an ordinary HTTP failure on these
    // endpoints, so a forced refresh is attempted before giving up on the
    // request. If the token really is dead, the refresh raises
    // AuthenticationError on the next pass and the loop stops there.
    if (error instanceof NestError && error.isRetryable) {
      try {
        await this.#ensureSession({ force: true })
      } catch (refreshError) {
        if (refreshError instanceof AuthenticationError) {
          this.#options.onFatal(refreshError)
          return false
        }
        this.#options.log.debug(`Session refresh failed: ${sanitizeError(refreshError)}`)
      }
    }

    return true
  }

  /** @returns `false` when the wait was cut short by shutdown. */
  async #waitBeforeReconnect(consecutiveFailures: number, error?: unknown): Promise<boolean> {
    if (this.#isStopped) {
      return false
    }

    // Honour the breaker's cooldown so loops do not spin while open.
    if (error instanceof CircuitBreakerError) {
      await sleep(error.retryAfterMs || RECONNECT_BASE_MS)
      return !this.#isStopped
    }

    // A clean end reconnects promptly; a failing one backs off. Without the
    // distinction, Nest's routine stream recycling would be punished with a
    // growing delay and thermostats would go minutes without updates.
    const serverDelay = error instanceof RateLimitError ? error.retryAfterMs : undefined
    const delayMs = consecutiveFailures === 0
      ? RECONNECT_BASE_MS
      : serverDelay ?? computeBackoffMs(consecutiveFailures)

    await sleep(delayMs)
    return !this.#isStopped
  }

  /** Periodic operator-visible status so a dead Observe loop is not silent. */
  #startStatusHeartbeat(): void {
    const intervalMs = 15 * 60_000
    this.#statusTimer = setInterval(() => {
      const { observeFrames, restCycles, knownObjects } = this.status
      this.#options.log.info(
        `Nest transport: ${observeFrames} Observe frame(s), ${restCycles} REST cycle(s), ${knownObjects} known object(s)`,
      )
    }, intervalMs)
    this.#statusTimer.unref?.()
  }

  #scheduleObserveStartupWarn(): void {
    if (this.#observeStartupWarnTimer) {
      clearTimeout(this.#observeStartupWarnTimer)
    }
    this.#observeStartupWarnTimer = setTimeout(() => {
      this.#observeStartupWarnTimer = null
      if (this.#isStopped || this.#observeFrames > 0 || this.#didWarnObserveSilent) {
        return
      }
      this.#didWarnObserveSilent = true
      this.#options.log.warn(
        'Observe produced no frames since startup — thermostats / Observe-only Protects wait until it connects.',
      )
    }, OBSERVE_STARTUP_WARN_MS)
    this.#observeStartupWarnTimer.unref?.()
  }
}
