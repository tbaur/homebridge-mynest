/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The Homebridge platform: discovery, state, and the update path.
 *
 * The platform owns the merged view of the home. Both transports hand it raw
 * updates, it folds them into the two state stores, rebuilds the inventory, and
 * pushes the result to accessories. Devices are published from the union of
 * both transports, because on a real account neither one sees the whole house.
 */

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge'
import {
  GLOBAL_ECO_DEVICE_ID,
  GLOBAL_ECO_DISPLAY_NAME,
  OBSERVE_SNAPSHOT_ABANDON_MS,
  OBSERVE_SNAPSHOT_SETTLE_MS,
  PLATFORM_NAME,
  PLUGIN_NAME,
  UUID_PREFIX,
  resolveEndpoints,
} from './settings'
import type { MyNestPlatformConfig, ResolvedConfig } from './types/config'
import {
  isDeviceOfKind,
  type DeviceInventory,
  type DeviceKind,
  type HvacMode,
  type NestDevice,
  type ThermostatState,
} from './types/device'
import type { BucketMap, TopazBucket } from './types/nest'
import {
  ApiParseError,
  AuthenticationError,
  CircuitBreakerError,
  ConfigurationError,
  NestError,
  NetworkError,
  SessionShapeError,
  TimeoutError,
  isFatalTransportError,
} from './errors'
import { NestTransport } from './api/transport'
import type { TraitUpdate } from './api/protobuf'
import { NestSignals, PAGERDUTY_STARTUP_LOG, type StopReason } from './nest-signals'
import { PagerDutySignals } from './pagerduty-signals'
import {
  buildThermostatSetpointWrite,
  type ThermostatSetpointWrite,
} from './api/thermostat-write'
import {
  DiagnosticsCollector,
  type DiagnosticsReaders,
} from './diagnostics/collector'
import { formatDiagnosticLine } from './diagnostics/format'
import type { DeviceGauges, DiagnosticsSnapshot } from './diagnostics/types'
import { cleanName, OBSERVE_DEVICE_PREFIX, toDeviceId, toResourceId } from './state/classify'
import { ObserveState } from './state/observe-state'
import { formatTopazArrival } from './state/protect-state'
import { buildInventory, listDevices } from './state/registry'
import { thermostatIdsForChangedComfortSensors } from './state/thermostat-state'
import { validateConfig } from './utils/validators'
import { createScopedLogger, type Logger } from './utils/logger'
import { computeBackoffMs } from './utils/retry'
import { sanitizeError, sanitizeString } from './utils/sanitizers'
import type { AccessoryContext } from './accessories/base'
import { NestAccessory } from './accessories/base'
import { GlobalEcoAccessory } from './accessories/global-eco'
import { ProtectAccessory } from './accessories/protect'
import { TemperatureSensorAccessory } from './accessories/temperature-sensor'
import { ThermostatAccessory } from './accessories/thermostat'

/**
 * Resolved once via `require` rather than a static `import`: `package.json`
 * lives outside the TypeScript `rootDir` (`src/`), so importing it would alter
 * the emitted `dist/` layout.
 */
function readPluginVersion(): string {
  try {
    return (require('../package.json') as { version: string }).version || 'unknown'
  } catch {
    return 'unknown'
  }
}

const PLUGIN_VERSION = readPluginVersion()

/**
 * How long to gather updates before pushing them to HomeKit.
 *
 * A single Observe reconnect delivers a full snapshot as dozens of frames in
 * quick succession. Rebuilding the inventory per frame would do the same work
 * dozens of times for one logical update; a short window collapses that into
 * one pass while staying far below the point a person would notice.
 */
const UPDATE_COALESCE_MS = 250

/**
 * How often to repeat the "authentication is still failing" line.
 *
 * A fatal stops both transports and every other periodic log, so this is the
 * only remaining signal that HomeKit's values are frozen.
 */
const FATAL_REMINDER_MS = 60 * 60_000

function tokenRejectedMessage(status: number): string {
  return `Nest rejected the token (HTTP ${status}). Get a new token from https://home.nest.com/session and restart Homebridge.`
}

/** A few words for the startup retry line; the full error goes to debug. */
function describeStartupFailure(error: unknown): string {
  if (error instanceof CircuitBreakerError) {
    return 'paused after repeated failures'
  }
  if (error instanceof TimeoutError) {
    return 'timed out'
  }
  if (error instanceof NetworkError) {
    return 'network error'
  }
  if (error instanceof ApiParseError) {
    return 'unexpected response'
  }
  if (error instanceof NestError && error.httpStatus !== undefined) {
    return `HTTP ${error.httpStatus}`
  }
  return sanitizeError(error)
}

function formatDelay(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)} min`
}

function stopReasonFor(error: Error): StopReason {
  if (error instanceof SessionShapeError) {
    return 'session'
  }
  return error instanceof ConfigurationError ? 'config' : 'token'
}

/** Device kinds as they read in the log. */
const KIND_LABELS: Record<DeviceKind, string> = {
  thermostat: 'thermostat',
  protect: 'Protect',
  temperature_sensor: 'temperature sensor',
}

/**
 * Concurrent Nest writes allowed when setting Eco across the whole house.
 *
 * Unbounded fan-out sent one BatchUpdateState POST per thermostat at once, with
 * no breaker in front of them; a single 429 or WAF 403 from that burst fails
 * the batch and the user retries, feeding the loop.
 */
const ECO_WRITE_CONCURRENCY = 2

/** Whether a redacted structured-log line is still valid JSON. */
function isParseableJson(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

export class MyNestPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service
  readonly Characteristic: typeof Characteristic
  readonly api: API

  readonly #log: Logger
  readonly #rawLog: Logging
  #config: ResolvedConfig | null = null
  #diagnostics: DiagnosticsCollector | null = null

  /** Restored and newly registered accessories, keyed by HAP UUID. */
  readonly #cachedAccessories = new Map<string, PlatformAccessory>()
  /** Live accessory handlers, keyed by device id. */
  readonly #handlers = new Map<string, NestAccessory<unknown>>()
  /** Optional house-wide Eco switch (not a Nest device). */
  #globalEco: GlobalEcoAccessory | null = null

  readonly #observe = new ObserveState((cap) => {
    this.#log.warn(
      `Observe: tracking ${cap} resources, ignoring the rest`,
    )
  })
  #buckets: BucketMap = {}
  #transport: NestTransport | null = null
  #pendingUpdate: NodeJS.Timeout | null = null
  #pendingChangedIds: Set<string> | null = null
  #bucketsChanged = false
  #isShuttingDown = false
  #hasFatal = false
  #startedAt = 0
  /**
   * Device resource ids seen during the current Observe reconnect burst.
   * `null` means we are not collecting (steady-state patches only).
   */
  #observeSnapshotIds: Set<string> | null = null
  #observeSnapshotSettleTimer: NodeJS.Timeout | null = null
  /** Guards against a session that connects but never delivers a device. */
  #observeSnapshotAbandonTimer: NodeJS.Timeout | null = null
  /**
   * True after at least one non-truncated Observe device burst has settled.
   * HomeKit prune must wait for this — early frames increment `observeFrames`
   * before thermostats land, and pruning then bounces every Observe-only tile.
   */
  #hasSettledObserveSnapshot = false
  /**
   * Observe `DEVICE_*` ids missing from a complete snapshot, and which snapshot
   * they were missing from.
   *
   * A device is removed only when two *consecutive* complete snapshots omit it,
   * so neither a truncated reconnect nor two unrelated absences weeks apart can
   * wipe part of the house. The value is the sequence number of the snapshot
   * that recorded the strike; a non-adjacent absence starts the count over.
   */
  readonly #observeRemovalCandidates = new Map<string, number>()
  /** Complete, non-truncated Observe snapshots seen this session. */
  #observeSnapshotSequence = 0
  /** Device ids that have appeared in the merged inventory since startup. */
  readonly #seenDeviceIds = new Set<string>()
  /**
   * Cached accessories not seen since startup, keyed by UUID, with the
   * snapshot sequence at which pruning first found them missing.
   *
   * A device seen this session only leaves the inventory through the Observe
   * and REST two-strike guards. A cached one that has not been seen has no
   * such history, so one settled snapshot after a restart is not enough to
   * remove it. It must still be missing after the next one.
   */
  readonly #unseenCachedStrikes = new Map<string, number>()
  /**
   * Inventory from the most recent sync, reused by the diagnostics gauges.
   *
   * Keeps the reported per-kind counts consistent with the handlers the same
   * pass published, and avoids rebuilding the whole merged view — every trait
   * re-read, every thermostat's comfort source re-resolved — for a heartbeat.
   */
  #lastInventory: DeviceInventory | null = null
  #diagnosticsTimer: NodeJS.Timeout | null = null
  #fatalReminderTimer: NodeJS.Timeout | null = null
  #startRetryTimer: NodeJS.Timeout | null = null
  #startRetryAttempt = 0
  #lastDiagnosticsHealth: 'healthy' | 'degraded' | null = null
  /** One-shot startup line after the first HomeKit inventory sync. */
  #hasLoggedPlatformReady = false
  /** House-level PagerDuty signals. Absent unless pagerdutySignals is on. */
  readonly #signals: NestSignals | null = null

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.api = api
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic
    this.#rawLog = log

    const raw = config as unknown as MyNestPlatformConfig
    this.#log = createScopedLogger(log, PLATFORM_NAME, raw.debug === true)

    // Read from the raw block so an invalid config can still page.
    if (raw.pagerdutySignals === true) {
      this.#log.info(PAGERDUTY_STARTUP_LOG)
      this.#signals = new NestSignals(new PagerDutySignals({
        plugin: PLUGIN_NAME,
        storagePath: api.user.storagePath(),
        log: this.#log,
      }))
    }

    try {
      const { config: resolved, warnings } = validateConfig(raw)
      this.#config = resolved
      this.#diagnostics = new DiagnosticsCollector({
        pluginVersion: PLUGIN_VERSION,
        config: resolved,
      })
      for (const warning of warnings) {
        this.#log.warn(warning)
      }
      if (resolved.allowThermostatControl) {
        this.#log.info('Thermostat control enabled')
      }
    } catch (error) {
      // Homebridge keeps running other platforms, so this must not throw. The
      // plugin simply publishes nothing and says why.
      this.#log.error(
        error instanceof ConfigurationError
          ? error.message
          : `Configuration is not usable: ${sanitizeError(error)}`,
      )
    }

    // Never let a rejection escape: Homebridge invokes this listener with no
    // handler, and an unhandled rejection terminates the whole process under
    // Node's default `--unhandled-rejections=throw`.
    this.api.on('didFinishLaunching', () => {
      this.#start().catch((error: unknown) => {
        this.#log.error(`Could not start: ${sanitizeError(error)}`)
      })
    })
    this.api.on('shutdown', () => this.#stop())
  }

  get resolvedConfig(): ResolvedConfig {
    if (!this.#config) {
      throw new ConfigurationError('The platform is not configured')
    }
    return this.#config
  }

  /** Homebridge replays cached accessories here before `didFinishLaunching`. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.#log.debug(`Restoring ${accessory.displayName} from cache`)
    this.#cachedAccessories.set(accessory.UUID, accessory)
    // A cached Protect can still be smoke/CO clear and active from the last
    // good session. No handler exists until Nest answers, so fault it now.
    this.#holdUnpublishedProtectAlarms()
  }

  async #start(): Promise<void> {
    if (!this.#config) {
      // Accessories are kept, for the same reason #handleFatal keeps them: a
      // typo, a half-edited config.json, or a truncated token would otherwise
      // destroy every room assignment, scene membership, and automation target
      // in the Home app — and fixing the config does not bring them back,
      // because HomeKit treats the re-registered accessories as new devices.
      // A config error is less severe than a revoked token, so it cannot
      // warrant a more destructive response.
      this.#log.error(
        'Invalid configuration; accessories kept but will not update until it is corrected.',
      )
      this.#holdUnpublishedProtectAlarms()
      this.#signals?.noteStopped('config')
      return
    }

    this.#holdUnpublishedProtectAlarms()
    this.#signals?.start()

    this.#startedAt = Date.now()

    const diagnostics = this.#diagnostics
    const transport = new NestTransport({
      accessToken: this.#config.accessToken,
      endpoints: resolveEndpoints(this.#config.fieldTest),
      log: this.#log,
      onTraits: (traits) => this.#applyTraits(traits),
      onBuckets: (buckets, updatedKeys) => this.#applyBuckets(buckets, updatedKeys),
      onObserveSessionStart: () => this.#beginObserveSnapshot(),
      onFatal: (error) => this.#handleFatal(error),
      onCircuitOpen: () => diagnostics?.breakerTrip(),
      onRestAlarmFeedChange: () => {
        // Force every Protect to re-evaluate smoke/CO from feed availability.
        this.#bucketsChanged = true
        this.#scheduleUpdate()
      },
      statusHeartbeatEnabled: this.#config.diagnosticsInterval <= 0,
      metrics: diagnostics
        ? {
            apiRequest: (ms, ok, options) => diagnostics.apiRequest(ms, ok, options),
            sessionLogin: () => diagnostics.sessionLogin(),
            restCycle: (ok, ms) => diagnostics.restCycle(ok, ms),
            observeReconnect: () => diagnostics.observeReconnect(),
            retry: () => diagnostics.retry(),
          }
        : undefined,
    })
    this.#transport = transport

    try {
      await transport.start()
    } catch (error) {
      // Only an unrecoverable failure may reach #handleFatal. `start()` opens a
      // session and runs one app_launch, so it also rejects for DNS, TLS,
      // timeout, 5xx, and breaker errors — none of which mean the token is bad.
      // Treating those as fatal permanently disabled the plugin for the life of
      // the process and told the user to paste a fresh token, which is exactly
      // what a Raspberry Pi that boots before its network is up would see.
      // Steady state already classifies these correctly; this is the boot path
      // catching up.
      if (isFatalTransportError(error)) {
        this.#handleFatal(error instanceof Error ? error : new Error(String(error)))
        return
      }
      // Shutdown aborts the in-flight start; no retry follows, so do not announce one.
      if (this.#isShuttingDown) {
        return
      }

      this.#log.debug(`Startup failed: ${sanitizeError(error)}`)
      this.#scheduleStartRetry(describeStartupFailure(error))
      return
    }

    this.#startRetryAttempt = 0
    this.#startDiagnostics()

    // REST is up; Observe usually follows within a second. Naming both avoids
    // implying thermostats are already live when only app_launch succeeded.
    this.#log.info('Connected to Nest')
    this.#signals?.noteConnected()
  }

  /**
   * Retry `#start` with backoff after a transient startup failure.
   *
   * `didFinishLaunching` fires once, so without this a single blip at boot left
   * the plugin permanently idle — and cache-restored Protect tiles keep whatever
   * smoke/CO value Homebridge persisted, with no handler to mark them faulted.
   */
  #scheduleStartRetry(reason: string): void {
    if (this.#isShuttingDown || this.#hasFatal || this.#startRetryTimer) {
      return
    }

    this.#transport?.stop()
    this.#transport = null
    this.#holdUnpublishedProtectAlarms()

    this.#startRetryAttempt++
    const delayMs = computeBackoffMs(this.#startRetryAttempt)
    this.#log.warn(`Could not connect to Nest (${reason}), retrying in ${formatDelay(delayMs)}`)

    this.#startRetryTimer = setTimeout(() => {
      this.#startRetryTimer = null
      if (this.#isShuttingDown || this.#hasFatal) {
        return
      }
      void this.#start().catch((error: unknown) => {
        this.#log.error(`Startup retry failed: ${sanitizeError(error)}`)
      })
    }, delayMs)
    this.#startRetryTimer.unref?.()
  }

  #stop(): void {
    this.#isShuttingDown = true

    if (this.#diagnosticsTimer) {
      try {
        if (this.#diagnostics) {
          this.#emitDiagnostic(
            'info',
            this.#diagnostics.snapshot('diagnostics.stop', this.#buildDiagnosticsReaders()),
          )
        }
      } catch (error) {
        this.#log.debug(`Failed to emit diagnostics stop snapshot: ${sanitizeError(error)}`)
      }
      clearInterval(this.#diagnosticsTimer)
      this.#diagnosticsTimer = null
    }

    if (this.#fatalReminderTimer) {
      clearInterval(this.#fatalReminderTimer)
      this.#fatalReminderTimer = null
    }

    if (this.#startRetryTimer) {
      clearTimeout(this.#startRetryTimer)
      this.#startRetryTimer = null
    }

    if (this.#pendingUpdate) {
      clearTimeout(this.#pendingUpdate)
      this.#pendingUpdate = null
    }
    this.#clearObserveSnapshotTimers()
    this.#observeSnapshotIds = null
    this.#observeRemovalCandidates.clear()
    this.#globalEco?.dispose()

    this.#transport?.stop()
    this.#transport = null
    this.#signals?.close()
  }

  /**
   * A failure nothing can recover from without a config change — almost always
   * an expired or revoked Nest Account access token.
   *
   * Homebridge has no way for a plugin to unload itself, so the transports are
   * stopped and the reason is logged once. Retrying a token Nest has refused
   * only produces the same refusal every few seconds.
   *
   * Accessories stay in HomeKit: Nest auth is a pasted session token that the
   * user must refresh manually, and tearing down rooms/automations for that
   * would be worse than showing last-known values until they restart with a
   * fresh token.
   */
  #handleFatal(error: Error): void {
    if (this.#hasFatal) {
      return
    }
    this.#hasFatal = true
    const isSessionShape = error instanceof SessionShapeError
    const message = error instanceof AuthenticationError
      ? tokenRejectedMessage(error.httpStatus)
      : error.message
    this.#log.error(message)
    this.#log.debug(`Stopped by: ${sanitizeError(error)}`)
    this.#signals?.noteStopped(stopReasonFor(error))

    // Mark Protect smoke/CO inactive/faulted while handlers can still refresh.
    // `#stop` sets `#isShuttingDown` and drops `#scheduleUpdate`, so the
    // transport's onRestAlarmFeedChange callback would not reach HomeKit.
    this.#holdUnpublishedProtectAlarms()
    try {
      this.#syncAccessories({
        changedIds: null,
        bucketsChanged: true,
        restAlarmFeedAvailable: false,
      })
    } catch (syncError) {
      this.#log.debug(
        `Could not mark Protect alarm feeds stale after auth failure: ${sanitizeError(syncError)}`,
      )
    }
    this.#stop()

    // Armed after #stop(), which clears it — that is what makes a real
    // Homebridge shutdown cancel the reminder. #stop() has just torn down the
    // transport heartbeat and the diagnostics timer, so without this the plugin
    // emits nothing ever again while HomeKit keeps serving frozen readings, and
    // the single error line above scrolls out of the log within hours.
    const reminder = isSessionShape
      ? 'Still stopped: unsupported Nest session format. Readings are frozen.'
      : `Still stopped: ${message}`
    this.#fatalReminderTimer = setInterval(() => {
      this.#log.error(reminder)
    }, FATAL_REMINDER_MS)
    this.#fatalReminderTimer.unref?.()
  }

  #applyTraits(traits: readonly TraitUpdate[]): void {
    const changed = this.#observe.apply(traits)
    this.#pendingChangedIds ??= new Set()
    for (const resourceId of changed) {
      // Observe keys resources as DEVICE_…; accessories are keyed by bare id.
      this.#pendingChangedIds.add(toDeviceId(resourceId))
    }

    if (this.#observeSnapshotIds) {
      for (const update of traits) {
        if (update.resourceId.startsWith(OBSERVE_DEVICE_PREFIX)) {
          this.#observeSnapshotIds.add(update.resourceId)
        }
      }
      this.#armObserveSnapshotSettle()
    }

    this.#scheduleUpdate()
  }

  /**
   * Start collecting the device set Nest sends on a fresh Observe connection.
   *
   * Two separate deadlines, because they answer different questions. The
   * *abandon* deadline covers "did this session ever deliver anything?" and has
   * to be long enough to absorb a TCP + TLS handshake plus gateway processing —
   * arming the short quiet-period timer here instead meant a merely slow
   * connection finalized an empty snapshot, which nulled the collector, stopped
   * re-arming, and left `#hasSettledObserveSnapshot` false so HomeKit pruning
   * never ran again for that session. The *settle* deadline is the quiet period
   * after the last trait, and only `#applyTraits` may arm it.
   */
  #beginObserveSnapshot(): void {
    if (this.#isShuttingDown) {
      return
    }
    this.#observeSnapshotIds = new Set()
    this.#clearObserveSnapshotTimers()

    this.#observeSnapshotAbandonTimer = setTimeout(() => {
      this.#observeSnapshotAbandonTimer = null
      if (this.#observeSnapshotIds?.size === 0) {
        // Nothing arrived at all; stop collecting so a trait-less session
        // cannot leave the collector open forever and block pruning.
        this.#observeSnapshotIds = null
        this.#log.debug('Observe session produced no devices before the snapshot deadline')
      }
    }, OBSERVE_SNAPSHOT_ABANDON_MS)
    this.#observeSnapshotAbandonTimer.unref?.()
  }

  #clearObserveSnapshotTimers(): void {
    if (this.#observeSnapshotSettleTimer) {
      clearTimeout(this.#observeSnapshotSettleTimer)
      this.#observeSnapshotSettleTimer = null
    }
    if (this.#observeSnapshotAbandonTimer) {
      clearTimeout(this.#observeSnapshotAbandonTimer)
      this.#observeSnapshotAbandonTimer = null
    }
  }

  /** After the opening burst goes quiet, drop Observe devices Nest omitted. */
  #armObserveSnapshotSettle(): void {
    if (this.#observeSnapshotSettleTimer) {
      clearTimeout(this.#observeSnapshotSettleTimer)
    }
    // The burst has started, so the "never delivered anything" guard is moot.
    if (this.#observeSnapshotAbandonTimer) {
      clearTimeout(this.#observeSnapshotAbandonTimer)
      this.#observeSnapshotAbandonTimer = null
    }

    this.#observeSnapshotSettleTimer = setTimeout(() => {
      this.#observeSnapshotSettleTimer = null
      this.#finalizeObserveSnapshot()
    }, OBSERVE_SNAPSHOT_SETTLE_MS)
    this.#observeSnapshotSettleTimer.unref?.()
  }

  #finalizeObserveSnapshot(): void {
    const snapshotIds = this.#observeSnapshotIds
    this.#observeSnapshotIds = null
    if (!snapshotIds || this.#isShuttingDown) {
      return
    }

    // An empty or drastically smaller burst is usually a truncated reconnect,
    // not a home that lost half its devices at once. Do not update removal
    // candidates from an incomplete inventory.
    const previousCount = this.#observe.deviceResourceCount
    if (snapshotIds.size === 0) {
      return
    }
    if (previousCount > 0 && snapshotIds.size * 2 < previousCount) {
      // Still clear candidates for devices Nest did name — a truncated burst
      // must not leave a present device one strike from deletion.
      for (const id of snapshotIds) {
        this.#observeRemovalCandidates.delete(id)
      }
      this.#log.warn(
        `Observe: incomplete reconnect (${snapshotIds.size} of ${previousCount} devices), keeping prior state`,
      )
      return
    }

    // A non-empty, non-truncated burst is enough to allow HomeKit prune — even
    // when Nest named zero removals this round.
    this.#hasSettledObserveSnapshot = true
    this.#observeSnapshotSequence++

    const knownDeviceIds = this.#observe.resourceIds
      .filter((id) => id.startsWith(OBSERVE_DEVICE_PREFIX))
    const missing = knownDeviceIds.filter((id) => !snapshotIds.has(id))

    for (const id of snapshotIds) {
      this.#observeRemovalCandidates.delete(id)
    }

    const toRemove = new Set<string>()
    for (const id of missing) {
      // The two strikes have to be *consecutive*. Recording only "has a strike"
      // meant a device legitimately absent from one snapshot on Monday and
      // another on Friday was removed, despite appearing in every snapshot in
      // between — because a strike was only cleared when that specific id
      // showed up in a complete snapshot. Comparing sequence numbers makes a
      // gap reset the count.
      const struckAt = this.#observeRemovalCandidates.get(id)
      if (struckAt === this.#observeSnapshotSequence - 1) {
        toRemove.add(id)
        this.#observeRemovalCandidates.delete(id)
      } else {
        this.#observeRemovalCandidates.set(id, this.#observeSnapshotSequence)
      }
    }

    if (toRemove.size > 0) {
      const live = new Set(knownDeviceIds.filter((id) => !toRemove.has(id)))
      const removed = this.#observe.retainDeviceResources(live)
      if (removed.length > 0) {
        this.#log.info(
          `Observe: ${removed.length} device(s) no longer reported`,
        )
      }
    }

    // Always sync after a settled burst so HomeKit prune (gated on
    // `#hasSettledObserveSnapshot`) can drop cached ghosts even when Nest
    // removed nothing from Observe state this round.
    this.#bucketsChanged = true
    this.#scheduleUpdate()
  }

  #applyBuckets(buckets: BucketMap, updatedKeys?: readonly string[]): void {
    this.#buckets = buckets
    this.#bucketsChanged = true
    this.#logTopazArrivals(buckets, updatedKeys)
    this.#scheduleUpdate()
  }

  /**
   * Log the raw Protect alarm fields whenever a topaz object arrives.
   *
   * The accessory summary stays quiet when the HomeKit sentence is unchanged,
   * which hides a stuck `auto_away`.
   */
  #logTopazArrivals(buckets: BucketMap, updatedKeys: readonly string[] | undefined): void {
    if (!updatedKeys) {
      return
    }

    for (const key of updatedKeys) {
      if (!key.startsWith('topaz.')) {
        continue
      }
      const id = key.slice('topaz.'.length)
      const value = buckets.topaz?.[id]
      if (!value || typeof value !== 'object') {
        continue
      }
      const topaz = value as TopazBucket
      const knownName = this.#lastInventory?.protects.get(id)?.identity.name
      const description = cleanName(topaz.description)
      this.#log.debug(formatTopazArrival(topaz, knownName ?? description ?? id))
    }
  }

  /** Collapse a burst of transport updates into one HomeKit refresh. */
  #scheduleUpdate(): void {
    if (this.#pendingUpdate || this.#isShuttingDown) {
      return
    }

    this.#pendingUpdate = setTimeout(() => {
      this.#pendingUpdate = null
      try {
        const changedIds = this.#pendingChangedIds
        const bucketsChanged = this.#bucketsChanged
        this.#pendingChangedIds = null
        this.#bucketsChanged = false
        this.#syncAccessories({ changedIds, bucketsChanged })
      } catch (error) {
        this.#log.error(`Could not apply a Nest update: ${sanitizeError(error)}`)
      }
    }, UPDATE_COALESCE_MS)

    this.#pendingUpdate.unref?.()
  }

  /** Rebuild the merged inventory and reconcile it with what HomeKit shows. */
  #syncAccessories(options: {
    changedIds: Set<string> | null
    bucketsChanged: boolean
    /**
     * Override transport feed availability (e.g. force stale on fatal auth
     * before `#stop` tears down the transport / blocks scheduled updates).
     */
    restAlarmFeedAvailable?: boolean
  }): void {
    if (!this.#config) {
      return
    }

    // Nothing to do — checked before building the inventory, which re-reads
    // every trait and re-resolves every thermostat's comfort source.
    if (!options.bucketsChanged && options.changedIds && options.changedIds.size === 0) {
      return
    }

    const isFeedAvailable = options.restAlarmFeedAvailable
      ?? this.#transport?.status.isRestAlarmFeedAvailable
      ?? false
    const inventory = buildInventory({
      observe: this.#observe,
      buckets: this.#buckets,
      ignoredDeviceIds: this.#config.ignoredDeviceIds,
      restAlarmFeedAvailable: isFeedAvailable,
    })
    this.#lastInventory = inventory

    // A reconnect snapshot names every device; a typical patch names one.
    // Refresh only the affected accessories unless REST buckets changed (which
    // can add/remove devices) or the change set is large.
    const devices = listDevices(inventory)
    this.#signals?.update(
      devices.filter((device) => isDeviceOfKind(device, 'protect')).map((device) => device.state),
      isFeedAvailable,
    )

    // A sensor patch does not name the thermostat that is displaying it.
    if (options.changedIds && !options.bucketsChanged) {
      const thermostatIds = devices
        .filter((device) => device.identity.kind === 'thermostat')
        .map((device) => device.identity.id)
      for (const id of thermostatIdsForChangedComfortSensors(
        this.#observe,
        thermostatIds,
        options.changedIds,
      )) {
        options.changedIds.add(id)
      }
    }

    const refreshAll = options.bucketsChanged
      || !options.changedIds
      || options.changedIds.size >= Math.max(8, Math.ceil(devices.length / 2))

    let pushedUpdates = 0
    for (const device of devices) {
      this.#seenDeviceIds.add(device.identity.id)
      try {
        const handler = this.#adoptHandler(device)
        if (handler) {
          if (refreshAll || options.changedIds?.has(device.identity.id)) {
            handler.update(device)
            pushedUpdates++
          }
        } else {
          this.#publish(device)
          pushedUpdates++
        }
      } catch (error) {
        this.#log.error(
          `Could not update ${device.identity.name}: ${sanitizeError(error)}`,
        )
      }
    }

    if (pushedUpdates > 0) {
      this.#diagnostics?.externalChange()
    }

    this.#markUnreportedHandlers(devices)
    this.#removeStaleAccessories(inventory)
    this.#syncGlobalEco(inventory)

    if (!this.#hasLoggedPlatformReady && !this.#hasFatal) {
      this.#hasLoggedPlatformReady = true
      this.#log.info('Platform ready')
    }
  }

  // Observe trait maps are dropped only by `#finalizeObserveSnapshot`, on the
  // two-strike evidence that Nest stopped reporting a device.
  //
  // Absence from `inventory` is deliberately *not* treated as that evidence.
  // Three kinds of resource are missing from inventory while Nest is still
  // streaming them: a device whose classifying trait has not arrived yet
  // (`classifyResource` needs a Protect/HVAC/temperature type, which can land
  // frames after `device_identity`), an unsupported product such as a camera or
  // lock, and a device the user put in `ignoredDeviceIds`. Pruning on inventory
  // absence discarded identity traits from earlier frames — so the device was
  // later republished unnamed and with no model or serial — and wiped the
  // Temperature Sensor state that `readComfortTemperatures` reads, which made a
  // thermostat's reported temperature flap between its paired sensor and its
  // own backplate.

  /**
   * The live handler for a device, or `undefined` when one must be published.
   *
   * A device can change kind after it was published. Observe can deliver a
   * Protect's temperature trait before its Protect trait, which classifies it
   * as a temperature sensor first. The old handler cannot grow smoke and CO
   * services, so its services are removed and the caller publishes the right
   * kind onto the same HomeKit accessory.
   */
  #adoptHandler(device: NestDevice): NestAccessory<unknown> | undefined {
    const handler = this.#handlers.get(device.identity.id)
    if (!handler || handler.kind === device.identity.kind) {
      return handler
    }
    this.#log.info(
      `${device.identity.name}: now a ${KIND_LABELS[device.identity.kind]}, rebuilding services`,
    )
    handler.removeAllServices()
    this.#handlers.delete(device.identity.id)
    return undefined
  }

  /**
   * Stop presenting last values as live for devices Nest dropped.
   *
   * Removal from HomeKit waits for Observe to settle, so a Protect that left
   * the inventory could otherwise keep a live all-clear indefinitely.
   */
  #markUnreportedHandlers(devices: readonly NestDevice[]): void {
    const reported = new Set(devices.map((device) => device.identity.id))
    for (const [deviceId, handler] of this.#handlers) {
      if (!reported.has(deviceId)) {
        handler.markUnreported()
      }
    }
  }

  /** Create or adopt the HomeKit accessory for a device seen for the first time. */
  #publish(device: NestDevice): void {
    const uuid = this.api.hap.uuid.generate(`${UUID_PREFIX}${device.identity.id}`)
    const category = this.#categoryFor(device.identity.kind)
    const context: AccessoryContext = {
      deviceId: device.identity.id,
      kind: device.identity.kind,
      displayName: device.identity.name,
    }

    const cached = this.#cachedAccessories.get(uuid)
    let accessory: PlatformAccessory

    if (cached) {
      accessory = cached
      accessory.context = context
      accessory.displayName = device.identity.name
      accessory.category = category
      this.api.updatePlatformAccessories([accessory])
    } else {
      // Category is required at register time on Homebridge 2 for room tiles.
      accessory = new this.api.platformAccessory(device.identity.name, uuid, category)
      accessory.category = category
      accessory.context = context
      this.#cachedAccessories.set(uuid, accessory)
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])

      // The id is here because config.schema.json points at this line as the way
      // to find a value for ignoredDeviceIds; there is no other route to it.
      this.#log.info(
        `Adding ${KIND_LABELS[device.identity.kind]} "${device.identity.name}" [${device.identity.id}]`,
      )
    }

    const log = createScopedLogger(this.#rawLog, device.identity.name, this.#config?.debug === true)
    this.#handlers.set(device.identity.id, this.#createHandler(accessory, device, log))
  }

  /** HAP accessory category so Home shows room tiles (required on Homebridge 2). */
  #categoryFor(kind: DeviceKind): number {
    const { Categories } = this.api.hap
    switch (kind) {
      case 'thermostat':
        return Categories.THERMOSTAT
      case 'protect':
      case 'temperature_sensor':
        return Categories.SENSOR
      default: {
        const exhaustive: never = kind
        return exhaustive
      }
    }
  }

  #createHandler(
    accessory: PlatformAccessory,
    device: NestDevice,
    log: Logger,
  ): NestAccessory<unknown> {
    if (isDeviceOfKind(device, 'thermostat')) {
      return new ThermostatAccessory(this, accessory, device, log)
    }
    if (isDeviceOfKind(device, 'protect')) {
      return new ProtectAccessory(this, accessory, device, log)
    }
    return new TemperatureSensorAccessory(this, accessory, device, log)
  }

  /**
   * Apply a HomeKit-originated thermostat change via Nest BatchUpdateState.
   *
   * No-ops when control is disabled so characteristics can stay writable for
   * HomeKit presentation without guessing at HVAC writes. The accessory logs
   * the user-facing success / ignore line.
   *
   * @returns The write that was sent, or `null` when control is off.
   */
  async applyThermostatWrite(
    deviceId: string,
    state: ThermostatState,
    patch: Partial<{
      mode: HvacMode
      targetTemperatureC: number
      targetTemperatureLowC: number
      targetTemperatureHighC: number
    }>,
  ): Promise<ThermostatSetpointWrite | null> {
    if (!this.#config?.allowThermostatControl) {
      return null
    }

    const transport = this.#transport
    if (!transport) {
      throw new ConfigurationError('Nest transport is not running')
    }

    const write = buildThermostatSetpointWrite(toResourceId(deviceId), state, patch)
    await transport.updateThermostatSettings(write)
    return write
  }

  /**
   * Set Eco on one thermostat via Nest BatchUpdateState.
   *
   * @returns `true` when a Nest write was sent; `false` when control is off.
   */
  async applyEcoWrite(deviceId: string, ecoOn: boolean): Promise<boolean> {
    if (!this.#config?.allowThermostatControl) {
      return false
    }

    const transport = this.#transport
    if (!transport) {
      throw new ConfigurationError('Nest transport is not running')
    }

    await transport.updateEcoMode(toResourceId(deviceId), ecoOn)
    return true
  }

  /**
   * Set Eco on every published Nest thermostat.
   *
   * @returns `true` only when every targeted thermostat accepted the write.
   *   `false` when control is off or there are no thermostats. Any failed
   *   write throws, including when some thermostats already accepted it.
   */
  async applyGlobalEcoWrite(ecoOn: boolean): Promise<boolean> {
    if (!this.#config?.allowThermostatControl) {
      return false
    }

    const transport = this.#transport
    if (!transport) {
      throw new ConfigurationError('Nest transport is not running')
    }

    // Live handlers only — cached ghosts awaiting prune must not fail the batch.
    // `context` is optional-chained because Homebridge assigns it verbatim from
    // the persisted cache, so an accessory stored without one restores with
    // `undefined` and would otherwise throw here and fail every Eco press.
    const deviceIds = [...this.#cachedAccessories.values()]
      .map((accessory) => accessory.context as AccessoryContext | undefined)
      .filter((context): context is AccessoryContext => (
        context?.kind === 'thermostat'
        && context.synthetic !== 'global_eco'
        && this.#handlers.has(context.deviceId)
      ))
      .map((context) => context.deviceId)

    if (deviceIds.length === 0) {
      this.#log.warn('Nest Eco Mode: no thermostats to update')
      return false
    }

    // Bounded fan-out: these are unguarded writes to a private Nest gateway.
    const results: PromiseSettledResult<void>[] = []
    for (let index = 0; index < deviceIds.length; index += ECO_WRITE_CONCURRENCY) {
      const batch = deviceIds.slice(index, index + ECO_WRITE_CONCURRENCY)
      results.push(...await Promise.allSettled(
        batch.map(async (deviceId) => {
          await transport.updateEcoMode(toResourceId(deviceId), ecoOn)
        }),
      ))
    }

    const failedIds: string[] = []
    for (const [index, result] of results.entries()) {
      const deviceId = deviceIds[index]
      if (deviceId && result.status === 'rejected') {
        failedIds.push(deviceId)
        this.#log.warn(`Nest Eco Mode: ${deviceId} failed: ${sanitizeError(result.reason)}`)
      }
    }

    if (failedIds.length > 0) {
      throw new Error(`${failedIds.length} of ${deviceIds.length} thermostats failed`)
    }

    return true
  }

  /**
   * Fault cached Protect smoke and CO that do not have a live handler yet.
   *
   * Homebridge will answer a paired read from the persisted characteristics
   * until a handler exists. After a healthy run those are a live all-clear.
   * The real accessory replaces these handlers when Nest publishes the device.
   */
  #holdUnpublishedProtectAlarms(): void {
    const { Characteristic } = this.api.hap

    for (const accessory of this.#cachedAccessories.values()) {
      const context = accessory.context as AccessoryContext | undefined
      if (context?.kind !== 'protect') {
        continue
      }
      if (context.deviceId && this.#handlers.has(context.deviceId)) {
        continue
      }

      for (const service of [
        accessory.getService(this.Service.SmokeSensor),
        accessory.getService(this.Service.CarbonMonoxideSensor),
        accessory.getService(this.Service.OccupancySensor),
      ]) {
        if (!service) {
          continue
        }
        // Do not install a throwing getter. The accessory list catches that
        // throw and substitutes the characteristic default, which is a clear.
        service.getCharacteristic(Characteristic.StatusActive).updateValue(false)
        service.getCharacteristic(Characteristic.StatusFault)
          .updateValue(Characteristic.StatusFault.GENERAL_FAULT)
      }
    }
  }

  /**
   * Drop accessories Nest no longer reports — never because a transport is down.
   *
   * Observe is required before any HomeKit unregister: typical thermostats are
   * Observe-only, and pruning against a REST-only inventory on an Observe outage
   * (including a slow boot) would bounce rooms and automations. REST-only
   * devices leave inventory via the transport's two-strike `app_launch` guard;
   * Observe-only devices leave via the two-strike reconnect snapshot prune.
   * The union inventory then makes them absent here.
   *
   * A cached accessory that Nest has not named since the restart has no strike
   * history, so one settled snapshot cannot prove it gone. It goes only when a
   * later snapshot also omits it.
   */
  #removeStaleAccessories(inventory: DeviceInventory): void {
    const status = this.#transport?.status
    if (!status) {
      return
    }

    // No Nest inventory at all yet — keep the Homebridge cache untouched.
    if (status.observeFrames === 0 && status.knownObjects === 0) {
      return
    }

    // Until Observe has named devices at least once this session, do not
    // unregister. A REST-only view cannot prove an Observe-only thermostat is
    // gone; keeping a ghost through an outage beats deleting a live room tile.
    if (status.observeFrames === 0) {
      return
    }

    // Opening (or reconnect) burst still landing — union inventory is partial.
    if (this.#observeSnapshotIds !== null || !this.#hasSettledObserveSnapshot) {
      return
    }

    const known = new Set(listDevices(inventory).map((device) => device.identity.id))

    for (const deviceId of [...this.#handlers.keys()]) {
      if (!known.has(deviceId)) {
        this.#handlers.delete(deviceId)
      }
    }

    for (const [uuid, accessory] of this.#cachedAccessories) {
      const context = accessory.context as AccessoryContext | undefined
      if (context?.synthetic === 'global_eco') {
        continue
      }
      if (context?.deviceId && known.has(context.deviceId)) {
        this.#unseenCachedStrikes.delete(uuid)
        continue
      }
      if (!this.#isRemovalConfirmed(uuid, context?.deviceId)) {
        continue
      }

      this.#unseenCachedStrikes.delete(uuid)
      this.#log.info(`Removing ${accessory.displayName}, no longer reported by Nest`)
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.#cachedAccessories.delete(uuid)
    }
  }

  /** Whether an accessory missing from the inventory has enough evidence to go. */
  #isRemovalConfirmed(uuid: string, deviceId: string | undefined): boolean {
    if (deviceId && this.#seenDeviceIds.has(deviceId)) {
      return true
    }
    const struckAt = this.#unseenCachedStrikes.get(uuid)
    if (struckAt === undefined) {
      this.#unseenCachedStrikes.set(uuid, this.#observeSnapshotSequence)
      return false
    }
    return this.#observeSnapshotSequence > struckAt
  }

  /**
   * Publish or refresh the optional house-wide Eco switch.
   *
   * On when every Observe thermostat has reported Eco. REST-only thermostats
   * are left out because they never get an Eco trait. Off when there is no
   * Observe thermostat or any observed one reports Eco off. Until the Observe
   * snapshot settles and every observed thermostat has reported Eco, the
   * switch keeps its value. Turning it on/off writes Eco to each thermostat
   * (requires `allowThermostatControl`).
   */
  #syncGlobalEco(inventory: DeviceInventory): void {
    if (!this.#config?.exposeGlobalEcoSwitch) {
      this.#removeGlobalEco()
      return
    }

    const thermostats = listDevices(inventory).filter((device) => isDeviceOfKind(device, 'thermostat'))

    if (!this.#globalEco) {
      this.#publishGlobalEco()
    }
    // REST-only thermostats never get an Eco trait. They must not block the
    // house switch for the life of the process. Until Observe has settled, and
    // while any Observe thermostat has not reported Eco, the aggregate is
    // unknown rather than Off, so the switch keeps what it shows.
    const observed = thermostats.filter((device) => device.identity.sources.observe)
    const isAggregateUnknown = !this.#hasSettledObserveSnapshot
      || observed.some((device) => device.state.isEcoActive === undefined)
    if (isAggregateUnknown) {
      return
    }
    const allEco = observed.length > 0
      && observed.every((device) => device.state.isEcoActive === true)
    this.#globalEco?.updateAllEco(allEco)
  }

  #publishGlobalEco(): void {
    const uuid = this.api.hap.uuid.generate(`${UUID_PREFIX}${GLOBAL_ECO_DEVICE_ID}`)
    const category = this.api.hap.Categories.SWITCH
    const displayName = GLOBAL_ECO_DISPLAY_NAME
    const context: AccessoryContext = {
      deviceId: GLOBAL_ECO_DEVICE_ID,
      kind: 'thermostat',
      displayName,
      synthetic: 'global_eco',
    }

    let accessory = this.#cachedAccessories.get(uuid)
    if (!accessory) {
      accessory = new this.api.platformAccessory(displayName, uuid, category)
      accessory.category = category
      accessory.context = context
      this.#cachedAccessories.set(uuid, accessory)
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.#log.info(`Adding ${displayName}`)
    } else {
      accessory.context = context
      accessory.displayName = displayName
      accessory.category = category
      this.api.updatePlatformAccessories([accessory])
    }

    const log = createScopedLogger(this.#rawLog, displayName, this.#config?.debug === true)
    this.#globalEco = new GlobalEcoAccessory(this, accessory, log)
  }

  #removeGlobalEco(): void {
    const uuid = this.api.hap.uuid.generate(`${UUID_PREFIX}${GLOBAL_ECO_DEVICE_ID}`)
    const accessory = this.#cachedAccessories.get(uuid)
    if (accessory) {
      this.#log.info(`Removing ${accessory.displayName}, turned off in settings`)
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.#cachedAccessories.delete(uuid)
    }
    this.#globalEco?.dispose()
    this.#globalEco = null
  }

  #diagnosticsIntervalMs(): number {
    const seconds = this.#config?.diagnosticsInterval ?? 0
    return seconds > 0 ? seconds * 1_000 : 0
  }

  /**
   * Starts the diagnostics subsystem: emits the boot snapshot and schedules the
   * heartbeat. No-op unless diagnosticsInterval > 0.
   */
  #startDiagnostics(): void {
    const interval = this.#diagnosticsIntervalMs()
    if (interval <= 0 || this.#isShuttingDown || this.#diagnosticsTimer || !this.#diagnostics) {
      return
    }

    try {
      const startReport = this.#diagnostics.snapshot(
        'diagnostics.start',
        this.#buildDiagnosticsReaders(),
      )
      this.#lastDiagnosticsHealth = startReport.lifecycle.health
      this.#emitDiagnostic('info', startReport)
    } catch (error) {
      this.#log.debug(`Failed to emit diagnostics start snapshot: ${sanitizeError(error)}`)
    }

    this.#diagnosticsTimer = setInterval(() => this.#diagnosticsHeartbeat(), interval)
    this.#diagnosticsTimer.unref?.()
  }

  /**
   * Emits one heartbeat. The line is a warning on the interval where health
   * flips from healthy to degraded, and info otherwise. A reader failure stays
   * inside the timer so it cannot crash Homebridge.
   */
  #diagnosticsHeartbeat(): void {
    if (!this.#diagnostics) {
      return
    }

    try {
      const report = this.#diagnostics.buildHeartbeat(this.#buildDiagnosticsReaders())
      const health = report.lifecycle.health
      const becameDegraded = this.#lastDiagnosticsHealth === 'healthy' && health === 'degraded'
      this.#emitDiagnostic(becameDegraded ? 'warn' : 'info', report)
      this.#lastDiagnosticsHealth = health
    } catch (error) {
      this.#log.debug(`Diagnostics heartbeat failed: ${sanitizeError(error)}`)
    }
  }

  #buildDiagnosticsReaders(): DiagnosticsReaders {
    return {
      transport: () => {
        const status = this.#transport?.status
        if (!status) {
          return {
            hasSession: false,
            observeState: 'stopped',
            restState: 'stopped',
            observeFrames: 0,
            restCycles: 0,
            knownObjects: 0,
            lastObserveFrameAgeSec: null,
            lastRestSuccessAgeSec: null,
            isRestAlarmFeedAvailable: false,
            isDecodeDegraded: false,
            circuitBreaker: { rest: 'CLOSED', observe: 'CLOSED' },
          }
        }
        return {
          hasSession: status.hasSession,
          observeState: status.observeState,
          restState: status.restState,
          observeFrames: status.observeFrames,
          restCycles: status.restCycles,
          knownObjects: status.knownObjects,
          lastObserveFrameAgeSec: status.lastObserveFrameAgeSec,
          lastRestSuccessAgeSec: status.lastRestSuccessAgeSec,
          isRestAlarmFeedAvailable: status.isRestAlarmFeedAvailable,
          isDecodeDegraded: status.isDecodeDegraded,
          circuitBreaker: {
            rest: status.circuitBreaker.rest.state,
            observe: status.circuitBreaker.observe.state,
          },
        }
      },
      devices: () => this.#collectDeviceGauges(),
      fatalActive: () => this.#hasFatal,
      uptimeSec: () => (
        this.#startedAt > 0 ? Math.round((Date.now() - this.#startedAt) / 1000) : 0
      ),
    }
  }

  #collectDeviceGauges(): DeviceGauges {
    const byKind = { thermostat: 0, protect: 0, temperature_sensor: 0 }
    let observeOnly = 0
    let restOnly = 0
    let both = 0

    // Every state change schedules a sync, so the cached inventory is current
    // whenever one exists; a fresh build is only needed before the first sync.
    const inventory = this.#lastInventory ?? (this.#config
      ? buildInventory({
        observe: this.#observe,
        buckets: this.#buckets,
        ignoredDeviceIds: this.#config.ignoredDeviceIds,
        restAlarmFeedAvailable: this.#transport?.status.isRestAlarmFeedAvailable ?? false,
      })
      : null)

    if (inventory) {
      for (const device of listDevices(inventory)) {
        byKind[device.identity.kind]++
        const { observe, rest } = device.identity.sources
        if (observe && rest) {
          both++
        } else if (observe) {
          observeOnly++
        } else if (rest) {
          restOnly++
        }
      }
    }

    return {
      total: this.#handlers.size,
      byKind,
      observeOnly,
      restOnly,
      both,
      ignored: this.#config?.ignoredDeviceIds.size ?? 0,
    }
  }

  /**
   * Emit a diagnostics report as a human-readable line.
   *
   * Homebridge's logger stringifies extra arguments onto the same line, so the
   * structured payload is either a separate JSON line (`structuredLogs`) or a
   * debug entry — matching sibling plugins.
   */
  #emitDiagnostic(level: 'info' | 'warn', report: DiagnosticsSnapshot): void {
    this.#log[level](formatDiagnosticLine(report))

    if (this.#config?.structuredLogs) {
      // The scoped logger runs the string through the redactor, whose header
      // rules match on substrings and would truncate the rest of the line. The
      // report carries no secrets, but "machine-readable" has to mean it: fall
      // back rather than ship a log pipeline something that will not parse.
      const line = JSON.stringify(report)
      const redacted = sanitizeString(line)
      if (isParseableJson(redacted)) {
        this.#log[level](redacted)
      } else {
        this.#log.debug('Diagnostics snapshot omitted: redaction made the JSON unparseable')
      }
      return
    }

    const { lifecycle, msg, ...groups } = report
    this.#log.debug('Diagnostics snapshot', {
      msg,
      ...groups,
      ...lifecycle,
    })
  }
}
