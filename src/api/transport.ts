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
  BATCH_UPDATE_MAX_ATTEMPTS,
  FORBIDDEN_FATAL_THRESHOLD,
  FORBIDDEN_REPROBE_MS,
  FRAME_DECODE_FAILURE_RATIO,
  FRAME_DECODE_WINDOW,
  LOOP_FAILURE_WARN_EVERY,
  MIN_SUBSCRIBE_CYCLE_MS,
  OBSERVE_IDLE_TIMEOUT_MS,
  OBSERVE_SILENCE_CHECK_MS,
  OBSERVE_STARTUP_WARN_MS,
  RECONNECT_BASE_MS,
  REDISCOVERY_INTERVAL_MS,
  REST_PROOF_OF_LIFE_MS,
  SESSION_EXPIRY_MARGIN_MS,
  SESSION_REFRESH_MS,
  STATUS_HEARTBEAT_MS,
  type NestEndpoints,
} from '../settings'
import {
  CircuitBreakerError,
  ConfigurationError,
  ForbiddenError,
  NestError,
  NetworkError,
  RateLimitError,
  TimeoutError,
  isCircuitBreakerFailure,
  isFatalTransportError,
} from '../errors'
import type { BucketMap, NestSession } from '../types/nest'
import type { TraitUpdate } from './protobuf'
import { decodeFrame } from './protobuf'
import { ObjectList, appLaunch, subscribeOnce } from './rest'
import { openSession } from './session'
import { runObserveSession, type Http2Connect } from './observe'
import type { FetchLike } from './http'
import { postBatchUpdateState } from './batch-update'
import {
  encodeEcoModeBatchUpdate,
  encodeTargetTemperatureBatchUpdate,
  type ThermostatSetpointWrite,
} from './thermostat-write'
import {
  CircuitBreaker,
  CircuitState,
  type CircuitBreakerStatus,
} from './circuit-breaker'
import { AlarmFeedClock, type RestRefresh } from './alarm-feed'
import type { Logger } from '../utils/logger'
import { OBSERVE_DEVICE_PREFIX } from '../state/classify'
import { computeBackoffMs, sleep, withRetry } from '../utils/retry'
import { sanitizeError } from '../utils/sanitizers'

export interface NestTransportOptions {
  accessToken: string
  endpoints: NestEndpoints
  log: Logger
  /** Called with every trait the Observe stream reports, snapshot or patch. */
  onTraits: (traits: readonly TraitUpdate[]) => void
  /**
   * Called with the full bucket map after any REST change.
   *
   * `updatedKeys` are the object keys in this response (`topaz.{id}`, and so
   * on). Absent on callers that only have the merged map.
   */
  onBuckets: (buckets: BucketMap, updatedKeys?: readonly string[]) => void
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
  /**
   * Overridable for tests; production uses the module constants.
   *
   * Both of these are quarter-hour and five-minute intervals, which no test can
   * wait out — and they are the only two operator signals that are on by
   * default, so leaving them unexercised is not an option either.
   */
  statusHeartbeatMs?: number
  observeSilenceCheckMs?: number
  forbiddenReprobeMs?: number
  /** Injected REST subscribe breaker (tests); defaults to a fresh instance. */
  restCircuitBreaker?: CircuitBreaker
  /** Injected `app_launch` breaker (tests); defaults to a fresh instance. */
  appLaunchCircuitBreaker?: CircuitBreaker
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
   * Seconds since the last REST refresh. An unanswered subscribe idle counts.
   * A truncated `app_launch` does not. `null` until the first refresh.
   */
  readonly lastRestSuccessAgeSec: number | null
  /**
   * Whether Protect smoke/CO (and REST occupancy) may be treated as live from
   * cached topaz. Decided by {@link AlarmFeedClock}. Accessories stay
   * published and are marked inactive and faulted when this is false.
   */
  readonly isRestAlarmFeedAvailable: boolean
  /**
   * True while most recent Observe frames fail to decode.
   *
   * Surfaced so health can go degraded: the stream still reports `connected`
   * and the frame counter still climbs, so nothing else distinguishes a Nest
   * schema change from a healthy home.
   */
  readonly isDecodeDegraded: boolean
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
  /** Guards `/v5/subscribe` on the account's transport host. */
  readonly #restBreaker: CircuitBreaker
  /**
   * Guards `app_launch` on the API host. Separate from {@link #restBreaker}
   * because the hosts fail independently, and an `app_launch` outage must not
   * block the subscribe that carries Protect alarms.
   */
  readonly #appLaunchBreaker: CircuitBreaker
  readonly #observeBreaker: CircuitBreaker

  #session: NestSession | null = null
  /** In-flight session open, shared so concurrent callers cannot stampede. */
  #sessionRefresh: Promise<NestSession> | null = null
  #isStopped = false
  /** Consecutive failures per transport, for log escalation. */
  #observeFailureStreak = 0
  #restFailureStreak = 0
  /** Most recent failure per transport, so a breaker trip can name its cause. */
  #lastObserveError: string | null = null
  #lastRestError: string | null = null
  /** Rolling window of frame decode outcomes; `true` means undecodable. */
  readonly #recentFrameOutcomes: boolean[] = []
  #isDecodeDegraded = false
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
  #observeSilenceTimer: NodeJS.Timeout | null = null
  readonly #forbiddenReprobeTimers = new Map<'observe' | 'rest', NodeJS.Timeout>()
  #observeStartupWarnTimer: NodeJS.Timeout | null = null
  #lastObserveFrameAt: number | null = null
  /** Decoded `DEVICE_` traits in the Observe session that is open now. */
  #decodedDeviceTraitsThisSession = 0
  readonly #loopRestartTimers = new Map<string, NodeJS.Timeout>()
  #observeSessionOpen = false
  #restLoopRunning = false
  /** True once the subscribe loop has started, so its exit can be told apart from startup. */
  #hasRestLoopStarted = false
  readonly #alarmFeed = new AlarmFeedClock()
  #wasRestAlarmFeedAvailable = false
  /** True after this process has logged that the alarm feed went unavailable. */
  #announcedAlarmFeedDown = false
  #restAlarmFeedStaleTimer: NodeJS.Timeout | null = null

  constructor(options: NestTransportOptions) {
    this.#options = options
    this.#restBreaker = options.restCircuitBreaker ?? new CircuitBreaker()
    this.#appLaunchBreaker = options.appLaunchCircuitBreaker ?? new CircuitBreaker()
    this.#observeBreaker = options.observeCircuitBreaker ?? new CircuitBreaker()
    this.#wireBreaker(this.#restBreaker, 'rest', 'REST')
    this.#wireBreaker(this.#appLaunchBreaker, 'rest', 'REST refresh')
    this.#wireBreaker(this.#observeBreaker, 'observe', 'Observe')
  }

  /** Attach logging + trip callback for one transport breaker. */
  #wireBreaker(breaker: CircuitBreaker, transport: 'rest' | 'observe', label: string): void {
    breaker.attachOnStateChange((from, to) => {
      if (to === CircuitState.OPEN) {
        // Often the first default-visible sign of trouble, so it names the
        // cause and the cooldown.
        const last = transport === 'observe' ? this.#lastObserveError : this.#lastRestError
        const cause = last ? ` (${last})` : ''
        const cooldown = breaker.getStatus().remainingResetTimeMs
        const retry = cooldown !== null ? `, retrying in ${Math.round(cooldown / 1000)}s` : ''
        this.#options.log.warn(`${label}: paused after repeated failures${cause}${retry}`)
      } else if (to === CircuitState.CLOSED) {
        this.#options.log.info(`${label}: recovered`)
      } else {
        this.#options.log.debug(`${label}: circuit ${from} -> ${to}`)
      }
      if (to === CircuitState.OPEN && from !== CircuitState.OPEN) {
        this.#options.onCircuitOpen?.(transport)
      }
      if (breaker === this.#restBreaker) {
        this.#emitRestAlarmFeedAvailability()
      }
    })
  }

  get status(): TransportStatus {
    const lastObserveFrameAgeSec = this.#lastObserveFrameAt === null
      ? null
      : Math.round((Date.now() - this.#lastObserveFrameAt) / 1000)
    const lastRefreshAt = this.#alarmFeed.lastRefreshAt
    const lastRestSuccessAgeSec = lastRefreshAt === null
      ? null
      : Math.round((Date.now() - lastRefreshAt) / 1000)

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
      isDecodeDegraded: this.#isDecodeDegraded,
      circuitBreaker: {
        rest: this.#restBreaker.getStatus(),
        observe: this.#observeBreaker.getStatus(),
      },
    }
  }

  /** Whether cached REST topaz may still be treated as a live Protect alarm feed. */
  #computeRestAlarmFeedAvailable(): boolean {
    return this.#alarmFeed.isLive(Date.now(), {
      isStopped: this.#isStopped,
      isForbiddenDead: this.#restForbiddenDead,
      hasLoopExited: this.#hasRestLoopStarted && !this.#restLoopRunning,
      isBreakerClosed: this.#restBreaker.state === CircuitState.CLOSED,
    })
  }

  /** Record a REST read that refreshes Protect alarm state. */
  #recordRestRefresh(refresh: RestRefresh): void {
    this.#alarmFeed.record(refresh, Date.now())
    this.#armRestAlarmFeedStaleTimer()
    this.#emitRestAlarmFeedAvailability()
  }

  /**
   * Fire {@link #emitRestAlarmFeedAvailability} when either clock ages out,
   * even if the subscribe loop is sleeping through a long backoff.
   */
  #armRestAlarmFeedStaleTimer(): void {
    this.#clearRestAlarmFeedStaleTimer()
    const expiresAt = this.#alarmFeed.ageExpiresAt()
    if (expiresAt === null) {
      return
    }
    const remainingMs = expiresAt - Date.now()
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
    const wasAvailable = this.#wasRestAlarmFeedAvailable
    this.#wasRestAlarmFeedAvailable = available
    // A return to normal is not a warning. The first success of the process
    // is not a restore: the feed has not been down yet.
    if (available) {
      if (!wasAvailable && this.#announcedAlarmFeedDown) {
        this.#options.log.info('Protect alarm feed restored')
        this.#announcedAlarmFeedDown = false
      }
    } else if (wasAvailable) {
      this.#announcedAlarmFeedDown = true
      this.#options.log.warn('Protect alarm feed unavailable, smoke/CO marked inactive')
    }
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
   * @throws {AuthenticationError} When the token is rejected.
   * @throws {SessionShapeError} When the session is one this plugin cannot use.
   *   Nothing can proceed without a session, so both are surfaced rather than retried.
   */
  async start(): Promise<void> {
    this.#session = await this.#openSession()
    await this.#runAppLaunch()

    // Both loops run for the life of the plugin and are never awaited. Their
    // bodies are guarded, but their catch handlers are not, so an unhandled
    // rejection here would terminate the whole Homebridge process under Node's
    // default `--unhandled-rejections=throw` — taking every other plugin down.
    this.#startLoop('Observe', () => this.#runObserveLoop())
    this.#startLoop('REST', () => this.#runSubscribeLoop())

    if (this.#options.statusHeartbeatEnabled !== false) {
      this.#startStatusHeartbeat()
    }
    this.#scheduleObserveStartupWarn()
    this.#startObserveSilenceWatch()
  }

  /**
   * Push a thermostat mode/setpoint change through BatchUpdateState.
   *
   * Observe-only thermostats have no REST `/v5/put` path; this is the write
   * Nest's own web app uses. Callers should already have gated on
   * `allowThermostatControl`.
   */
  async updateThermostatSettings(write: ThermostatSetpointWrite): Promise<void> {
    await this.#postBatchUpdate(
      encodeTargetTemperatureBatchUpdate(write),
      'cannot write thermostat settings',
    )
  }

  /** Push Eco on/off through BatchUpdateState for one thermostat. */
  async updateEcoMode(resourceId: string, ecoOn: boolean): Promise<void> {
    await this.#postBatchUpdate(
      encodeEcoModeBatchUpdate(resourceId, ecoOn),
      'cannot write thermostat Eco mode',
    )
  }

  async #postBatchUpdate(body: Buffer, stoppedMessage: string): Promise<void> {
    if (this.#isStopped) {
      throw new ConfigurationError(`Nest transport is stopped; ${stoppedMessage}`)
    }

    const session = await this.#ensureSession()
    const started = Date.now()

    try {
      // Retried on transport-level failures only. BatchUpdateState setpoint and
      // Eco writes carry absolute values rather than deltas, so replaying one
      // is safe — and without a retry a single dropped packet silently reverts
      // the user's thermostat change.
      await withRetry(
        () => postBatchUpdateState({
          session,
          endpoints: this.#options.endpoints,
          body,
          signal: this.#abort.signal,
          fetchImpl: this.#options.fetchImpl,
        }),
        {
          maxAttempts: BATCH_UPDATE_MAX_ATTEMPTS,
          signal: this.#abort.signal,
          isRetryable: (error) => error instanceof NetworkError || error instanceof TimeoutError,
          onRetry: (attempt, delayMs, error) => {
            this.#options.metrics?.retry?.()
            this.#options.log.debug(
              `BatchUpdateState attempt ${attempt} failed (${sanitizeError(error)}); retrying in ${delayMs}ms`,
            )
          },
        },
      )
      this.#options.metrics?.apiRequest?.(Date.now() - started, true, { networked: true })
      // Success is logged by the accessory with the HomeKit display name.
    } catch (error) {
      this.#options.metrics?.apiRequest?.(Date.now() - started, false, { networked: true })
      // Accessory handlers log once and revert HomeKit — do not warn here too.
      throw error
    }
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
    if (this.#observeSilenceTimer) {
      clearInterval(this.#observeSilenceTimer)
      this.#observeSilenceTimer = null
    }
    for (const timer of this.#forbiddenReprobeTimers.values()) {
      clearTimeout(timer)
    }
    this.#forbiddenReprobeTimers.clear()
    if (this.#observeStartupWarnTimer) {
      clearTimeout(this.#observeStartupWarnTimer)
      this.#observeStartupWarnTimer = null
    }
    this.#clearRestAlarmFeedStaleTimer()
    for (const timer of this.#loopRestartTimers.values()) {
      clearTimeout(timer)
    }
    this.#loopRestartTimers.clear()
    // Deliberately not emitting availability here. `#isStopped` forces the feed
    // to compute as unavailable, so an orderly shutdown would log a
    // fault-shaped warning on every restart — training operators who alert on
    // warn to ignore the one message that matters during a real outage.
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
          signal: this.#abort.signal,
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
   * Re-open the session when it has aged out.
   *
   * A rejected session (HTTP 401) is fatal rather than a refresh trigger: the
   * session is derived from the configured token, so a new one would be
   * rejected too. When Nest reports an expiry sooner than the fixed cadence,
   * that wins.
   *
   * Concurrent callers share one refresh. Four call sites can race — both run
   * loops, `app_launch`, and every BatchUpdateState write — and each caller
   * that arrives during an in-flight open would otherwise start its own, with
   * up to `MAX_REQUEST_ATTEMPTS` retries behind it. A five-thermostat
   * global Eco press against a stale session was fifteen session opens.
   */
  async #ensureSession(): Promise<NestSession> {
    if (this.#session && !this.#isSessionStale(this.#session)) {
      return this.#session
    }

    this.#sessionRefresh ??= (async () => {
      this.#options.log.debug('Refreshing the Nest session')
      try {
        const session = await this.#openSession()
        this.#session = session
        return session
      } finally {
        this.#sessionRefresh = null
      }
    })()

    return this.#sessionRefresh
  }

  /** Whether a session has aged out, by Nest's own expiry or the fixed cadence. */
  #isSessionStale(session: NestSession): boolean {
    const now = Date.now()
    if (session.expiresAt !== undefined && now >= session.expiresAt - SESSION_EXPIRY_MARGIN_MS) {
      return true
    }
    return now - session.openedAt > SESSION_REFRESH_MS
  }

  /** Pull the whole account and publish it. */
  async #runAppLaunch(): Promise<void> {
    // Recorded before the call so a failing or truncated launch still spaces
    // the next scheduled one.
    this.#lastAppLaunchAt = Date.now()
    const session = await this.#ensureSession()
    const startedAt = Date.now()

    try {
      const objects = await this.#appLaunchBreaker.execute(
        () => withRetry(
          () => appLaunch({
            session,
            endpoints: this.#options.endpoints,
            bucketTypes: APP_LAUNCH_BUCKET_TYPES,
            fetchImpl: this.#options.fetchImpl,
            signal: this.#abort.signal,
          }),
          {
            signal: this.#abort.signal,
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

      const snapshot = this.#objects.applyAppLaunchSnapshot(objects)
      if (snapshot.truncated) {
        this.#options.log.warn(
          `REST: incomplete device list (${objects.length} of ${snapshot.previousCount}), keeping prior state`,
        )
      } else if (snapshot.dropped.length > 0) {
        this.#options.log.debug(`REST: ${snapshot.dropped.length} object(s) no longer listed`)
      }
      this.#publishBuckets(objects.map((object) => object.object_key))
      this.#options.metrics?.apiRequest?.(Date.now() - startedAt, true)
      this.#options.metrics?.restCycle?.(true, Date.now() - startedAt)
      // A truncated body omitted Protects, so it is not a refresh for them.
      if (!snapshot.truncated) {
        this.#recordRestRefresh('answered')
      }
    } catch (error) {
      if (this.#isStopped) {
        throw error
      }
      const networked = !(error instanceof CircuitBreakerError)
      this.#options.metrics?.apiRequest?.(Date.now() - startedAt, false, networked)
      this.#options.metrics?.restCycle?.(false, Date.now() - startedAt)
      throw error
    }
  }

  /**
   * Which scheduled `app_launch` is due before the next subscribe, if any.
   *
   * `app_launch` doubles as a proof of life. The subscribe long-poll can
   * legitimately time out with no response on a quiet house, so without a
   * call that always produces a real answer there is no way to tell a
   * silent-but-healthy account from a route that is swallowing traffic. A
   * truncated or failed launch does not refresh the answer clock, so the age
   * check alone would launch on every cycle. The attempt time spaces them.
   */
  #dueAppLaunch(): 'proof_of_life' | 'rediscovery' | null {
    const now = Date.now()
    const sinceLaunchMs = now - this.#lastAppLaunchAt
    const lastAnsweredAt = this.#alarmFeed.lastAnsweredAt
    const isAnswerOld = lastAnsweredAt === null || now - lastAnsweredAt >= REST_PROOF_OF_LIFE_MS
    if (isAnswerOld && sinceLaunchMs >= REST_PROOF_OF_LIFE_MS) {
      return 'proof_of_life'
    }
    return sinceLaunchMs >= REDISCOVERY_INTERVAL_MS ? 'rediscovery' : null
  }

  /**
   * Run a due `app_launch` without letting its failure block the subscribe.
   *
   * The two calls go to different hosts. Subscribe still runs after a failed
   * launch, so Protect alarms keep arriving while the API host is down.
   *
   * @returns `false` when the loop must stop, having already reported why.
   */
  async #runDueAppLaunch(): Promise<boolean> {
    const due = this.#dueAppLaunch()
    if (due === null) {
      return true
    }
    if (due === 'proof_of_life') {
      this.#options.log.debug('No REST response from Nest recently; running app_launch to confirm reachability')
    }
    try {
      await this.#runAppLaunch()
      return true
    } catch (error) {
      if (this.#isStopped) {
        return false
      }
      return this.#handleLoopError('REST refresh', error, 'rest')
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
      this.#decodedDeviceTraitsThisSession = 0
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

        // Only a stream that delivered a device trait clears the backoff.
        // Nest sends a resource catalogue as frame 0 on every connection, so
        // frame count and a long-lived silent socket are not evidence the
        // thermostat path is alive.
        const wasProductive = this.#decodedDeviceTraitsThisSession > 0
        if (wasProductive) {
          consecutiveFailures = 0
          this.#observeForbidden = 0
          this.#noteLoopSuccess('observe')
        } else {
          consecutiveFailures++
        }

        this.#options.log.debug(
          `Observe stream ended (${result.reason}) after ${result.frameCount} frame(s) in ${Math.round(result.durationMs / 1000)}s`,
        )
      } catch (error) {
        this.#observeSessionOpen = false
        if (this.#isStopped) {
          return
        }
        // A stream that delivered device data and then dropped was healthy
        // while it lasted. Without this, routine resets after productive
        // sessions climb the backoff to its cap.
        if (this.#decodedDeviceTraitsThisSession > 0) {
          consecutiveFailures = 0
          this.#observeForbidden = 0
          this.#noteLoopSuccess('observe')
        }
        if (!this.#handleLoopError('Observe', error, 'observe')) {
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

  /**
   * Track how many recent frames failed to parse, and say so if most of them do.
   *
   * A pinned `WEB_APP_VERSION` against an unversioned private API means a Nest
   * schema change is the most likely way this plugin breaks. Its signature is
   * every frame decoding to nothing while `observeFrames` climbs and health
   * stays healthy — completely silent without this.
   */
  #noteFrameDecode(isUndecodable: boolean): void {
    this.#recentFrameOutcomes.push(isUndecodable)
    if (this.#recentFrameOutcomes.length > FRAME_DECODE_WINDOW) {
      this.#recentFrameOutcomes.shift()
    }

    if (this.#recentFrameOutcomes.length < FRAME_DECODE_WINDOW) {
      return
    }

    const failed = this.#recentFrameOutcomes.filter(Boolean).length
    const isDegraded = failed / this.#recentFrameOutcomes.length > FRAME_DECODE_FAILURE_RATIO

    // Held as state rather than a one-shot warning. A schema change is the most
    // likely way this plugin breaks, and its signature is every frame decoding
    // to nothing while `observeFrames` climbs and the stream reports connected —
    // so a single log line that scrolls away leaves the plugin reporting perfect
    // health while every reading in the house is frozen.
    if (isDegraded === this.#isDecodeDegraded) {
      return
    }
    this.#isDecodeDegraded = isDegraded

    if (isDegraded) {
      this.#options.log.warn(
        `Observe: ${failed} of the last ${this.#recentFrameOutcomes.length} updates unreadable, Nest may have changed its format`,
      )
    } else {
      this.#options.log.info('Observe: updates readable again')
    }
  }

  /**
   * Hand the merged bucket map to the platform.
   *
   * Kept outside the callers' network try/catch. A throw from platform-side
   * state merging is not a Nest failure, and counting it as one drove the
   * circuit breaker, forced a session refresh, and reported a local bug to the
   * operator as a connectivity problem — while never naming the real fault.
   */
  #publishBuckets(updatedKeys: readonly string[]): void {
    let buckets
    try {
      buckets = this.#objects.toBuckets()
    } catch (error) {
      this.#options.log.error(`REST: could not read update: ${sanitizeError(error)}`)
      return
    }

    try {
      this.#options.onBuckets(buckets, updatedKeys)
    } catch (error) {
      this.#options.log.error(`REST: could not apply update: ${sanitizeError(error)}`)
    }
  }

  #handleObserveFrame(frame: Buffer): void {
    this.#observeFrames++
    this.#lastObserveFrameAt = Date.now()

    const { traits, status, isUndecodable } = decodeFrame(frame)
    this.#noteFrameDecode(isUndecodable === true)

    // The first frame of every connection is a resource catalogue in a shape
    // `StreamBody` does not describe, so an empty decode is routine rather
    // than a problem worth reporting.
    if (status?.code !== undefined && status.code !== 0) {
      this.#options.log.debug(
        `Observe stream reported status ${status.code}${status.message ? `: ${status.message}` : ''}`,
      )
    }

    // Observe sends device traits only on change, so a quiet house can go a
    // long time without one. This counts them only to judge a session productive.
    if (traits.some((trait) => trait.resourceId.startsWith(OBSERVE_DEVICE_PREFIX))) {
      this.#decodedDeviceTraitsThisSession++
    }

    if (traits.length > 0) {
      this.#options.onTraits(traits)
    }
  }

  /**
   * Run a transport loop, and start it again if it throws.
   *
   * A normal return (shutdown, auth failure, 403 reprobe) does not come
   * through here. The 403 path schedules its own reprobe.
   */
  #startLoop(label: 'Observe' | 'REST', run: () => Promise<void>): void {
    void run().catch((error: unknown) => {
      if (label === 'REST') {
        this.#restLoopRunning = false
        this.#emitRestAlarmFeedAvailability()
      }
      this.#options.log.error(`${label}: stopped unexpectedly: ${sanitizeError(error)}`)
      if (this.#isStopped) {
        return
      }
      const existing = this.#loopRestartTimers.get(label)
      if (existing) {
        clearTimeout(existing)
      }
      const timer = setTimeout(() => {
        this.#loopRestartTimers.delete(label)
        if (this.#isStopped) {
          return
        }
        this.#options.log.info(`${label}: restarting`)
        this.#startLoop(label, run)
      }, RECONNECT_BASE_MS)
      timer.unref?.()
      this.#loopRestartTimers.set(label, timer)
    })
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
    this.#hasRestLoopStarted = true

    while (!this.#isStopped) {
      // Re-check before each attempt so an age-based stale flip during backoff
      // still notifies the platform even if the timer was cleared somehow.
      this.#emitRestAlarmFeedAvailability()
      if (!(await this.#runDueAppLaunch())) {
        this.#restLoopRunning = false
        // Shutdown is not an outage; see `stop()`.
        if (!this.#isStopped) {
          this.#emitRestAlarmFeedAvailability()
        }
        return
      }
      const cycleStartedAt = Date.now()

      try {
        const session = await this.#ensureSession()
        const result = await this.#restBreaker.execute(
          () => subscribeOnce({
            session,
            endpoints: this.#options.endpoints,
            revisions: this.#objects.revisions,
            fetchImpl: this.#options.fetchImpl,
            signal: this.#abort.signal,
          }),
          { isFailure: isCircuitBreakerFailure },
        )

        this.#restCycles++
        consecutiveFailures = 0
        this.#restForbidden = 0
        this.#noteLoopSuccess('rest')
        // Subscribe is a long-poll by design (idle or not). Never fold its wait
        // into API latency percentiles — session/app_launch remain the samples.
        this.#options.metrics?.apiRequest?.(Date.now() - cycleStartedAt, true, {
          sampleLatency: false,
        })
        this.#options.metrics?.restCycle?.(true, Date.now() - cycleStartedAt)
        // Subscribe sends revisions for every known object, so an answer,
        // even an empty one, covers all of them.
        this.#recordRestRefresh(result.hadResponse ? 'answered' : 'unanswered')

        if (!result.isIdle) {
          this.#objects.merge(result.objects)
          this.#publishBuckets(result.objects.map((object) => object.object_key))
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
        if (!this.#handleLoopError('REST', error, 'rest')) {
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
        await sleep(MIN_SUBSCRIBE_CYCLE_MS - elapsed, this.#abort.signal)
      }
    }
  }

  /**
   * Decide whether a loop can carry on after a failure.
   *
   * HTTP 403 counters are per-transport. A 403 does not mean the token is
   * revoked, on one transport or on both. Each transport probes again after
   * its cooldown. HTTP 401 and a session this plugin cannot use are the stop.
   *
   * @returns `false` when the loop must stop, having already reported why.
   */
  #handleLoopError(
    context: string,
    error: unknown,
    transport: 'observe' | 'rest',
  ): boolean {
    if (this.#abort.signal.aborted) {
      return false
    }

    if (isFatalTransportError(error)) {
      this.#options.onFatal(error as Error)
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
      this.#options.log.warn(`${context}: HTTP 403 (${count}/${FORBIDDEN_FATAL_THRESHOLD})`)
      if (count >= FORBIDDEN_FATAL_THRESHOLD) {
        if (transport === 'observe') {
          this.#observeForbiddenDead = true
        } else {
          this.#restForbiddenDead = true
        }

        // A 403 is the edge refusing this client. It is not proof the token
        // was revoked, including when both transports hit the budget. Tell
        // the operator that, and probe again after the cooldown.
        const minutes = Math.round(
          (this.#options.forbiddenReprobeMs ?? FORBIDDEN_REPROBE_MS) / 60_000,
        )
        this.#options.log.error(`${context}: blocked by Nest (HTTP 403), retrying in ${minutes} min`)
        this.#scheduleForbiddenReprobe(transport)
        return false
      }
    } else {
      this.#reportLoopFailure(context, error, transport)
    }

    // No forced session refresh here. HTTP 401 is fatal above, and refreshing
    // on a retryable error turns one failed request into several, on both
    // loops at once, including in answer to a 429 or a 403 edge block.
    return true
  }

  /**
   * Bring a 403-dead transport back after a cooling-off period.
   *
   * Fail-fast is right; permanent is not. A WAF block clears on its own, and the
   * plugin has no other way to notice that it has.
   */
  #scheduleForbiddenReprobe(transport: 'observe' | 'rest'): void {
    if (this.#isStopped || this.#forbiddenReprobeTimers.has(transport)) {
      return
    }

    const timer = setTimeout(() => {
      this.#forbiddenReprobeTimers.delete(transport)
      if (this.#isStopped) {
        return
      }

      this.#options.log.info(`${transport === 'rest' ? 'REST' : 'Observe'}: retrying after HTTP 403 cooldown`)

      if (transport === 'observe') {
        this.#observeForbiddenDead = false
        this.#observeForbidden = 0
        this.#startLoop('Observe', () => this.#runObserveLoop())
      } else {
        this.#restForbiddenDead = false
        this.#restForbidden = 0
        this.#emitRestAlarmFeedAvailability()
        this.#startLoop('REST', () => this.#runSubscribeLoop())
      }
    }, this.#options.forbiddenReprobeMs ?? FORBIDDEN_REPROBE_MS)
    timer.unref?.()
    this.#forbiddenReprobeTimers.set(transport, timer)
  }

  /**
   * Report a transport failure at a level an operator will actually see.
   *
   * Logging every non-403 failure at debug meant a persistently broken plugin
   * was silent by default: a sub-500 status neither trips the breaker nor
   * counts toward the 403 budget, so nothing else surfaced it either. The first
   * failure and every tenth after it are warnings; the rest stay at debug so a
   * flapping connection cannot flood the log.
   */
  #reportLoopFailure(context: string, error: unknown, transport: 'observe' | 'rest'): void {
    const streak = transport === 'observe'
      ? ++this.#observeFailureStreak
      : ++this.#restFailureStreak

    const line = `${context}: failed ${streak}x in a row: ${sanitizeError(error)}`

    const summary = error instanceof NestError ? error.code : 'UNKNOWN'
    if (transport === 'observe') {
      this.#lastObserveError = summary
    } else {
      this.#lastRestError = summary
    }

    if (streak === 1 || streak % LOOP_FAILURE_WARN_EVERY === 0) {
      this.#options.log.warn(line)
    } else {
      this.#options.log.debug(line)
    }
  }

  /** Clear a transport's failure streak after a good cycle. */
  #noteLoopSuccess(transport: 'observe' | 'rest'): void {
    if (transport === 'observe') {
      this.#observeFailureStreak = 0
    } else {
      this.#restFailureStreak = 0
    }
  }

  /** @returns `false` when the wait was cut short by shutdown. */
  async #waitBeforeReconnect(consecutiveFailures: number, error?: unknown): Promise<boolean> {
    if (this.#isStopped) {
      return false
    }

    // Honour the breaker's cooldown so loops do not spin while open.
    if (error instanceof CircuitBreakerError) {
      await sleep(error.retryAfterMs || RECONNECT_BASE_MS, this.#abort.signal)
      return !this.#isStopped
    }

    // A clean end reconnects promptly; a failing one backs off. Without the
    // distinction, Nest's routine stream recycling would be punished with a
    // growing delay and thermostats would go minutes without updates.
    const serverDelay = error instanceof RateLimitError ? error.retryAfterMs : undefined
    const delayMs = consecutiveFailures === 0
      ? RECONNECT_BASE_MS
      : serverDelay ?? computeBackoffMs(consecutiveFailures)

    await sleep(delayMs, this.#abort.signal)
    return !this.#isStopped
  }

  /**
   * Periodic operator-visible status so a dead Observe loop is not silent.
   *
   * Reports deltas and ages rather than cumulative totals: a running count
   * requires the reader to diff two lines fifteen minutes apart to learn
   * anything, and this is the only signal that is on by default.
   */
  #startStatusHeartbeat(): void {
    let previousFrames = this.#observeFrames
    let previousCycles = this.#restCycles

    this.#statusTimer = setInterval(() => {
      const status = this.status
      const frameDelta = status.observeFrames - previousFrames
      const cycleDelta = status.restCycles - previousCycles
      previousFrames = status.observeFrames
      previousCycles = status.restCycles

      const observeAge = status.lastObserveFrameAgeSec ?? '-'
      const restAge = status.lastRestSuccessAgeSec ?? '-'

      this.#options.log.info(
        `Status: Observe +${frameDelta} (last ${observeAge}s ago), REST +${cycleDelta} (last ${restAge}s ago), `
        + `alarm feed ${status.isRestAlarmFeedAvailable ? 'live' : 'STALE'}`,
      )
    }, this.#options.statusHeartbeatMs ?? STATUS_HEARTBEAT_MS)
    this.#statusTimer.unref?.()
  }

  /**
   * Standing alarm for an Observe stream that stopped delivering.
   *
   * The startup warning is one-shot, so a stream that is healthy at 60s and
   * dies at hour five produced no warning at all — despite Observe being the
   * only source of thermostat state on modern accounts.
   */
  #startObserveSilenceWatch(): void {
    this.#observeSilenceTimer = setInterval(() => {
      if (this.#isStopped || this.#observeForbiddenDead) {
        return
      }
      // `null` means Observe has *never* delivered a frame — strictly worse than
      // a stream that went quiet, and previously invisible here because the
      // check required a non-null age. That case got one warning at the 60s mark
      // and nothing afterwards, while HomeKit had no thermostats at all.
      const ageSec = this.status.lastObserveFrameAgeSec
      if (ageSec === null) {
        this.#options.log.warn('Observe: never connected, thermostats unavailable')
      } else if (ageSec * 1_000 > OBSERVE_IDLE_TIMEOUT_MS) {
        this.#options.log.warn(`Observe: no data for ${ageSec}s, thermostat readings stale`)
      }
    }, this.#options.observeSilenceCheckMs ?? OBSERVE_SILENCE_CHECK_MS)
    this.#observeSilenceTimer.unref?.()
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
      this.#options.log.warn('Observe: no data since startup, still connecting')
    }, OBSERVE_STARTUP_WARN_MS)
    this.#observeStartupWarnTimer.unref?.()
  }
}
