#!/usr/bin/env node
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Live read-only check of the compiled plugin against a Nest Account.
 *
 * Drives code in `dist/` (session → app_launch → inventory merge → short Observe
 * listen) so a mapping bug shows up here rather than only in someone's Home app.
 *
 * Run `npm run build` first.
 *
 * Usage:
 *   node scripts/verify.mjs              discover + listen ~30s
 *   node scripts/verify.mjs --listen 90  listen longer
 *   node scripts/verify.mjs --verbose    include per-trait stream detail
 *
 * Requires `NEST_ACCESS_TOKEN` in the environment or in a gitignored `.env`.
 * Read-only. Does not write setpoints or modes.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stdout } from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const distDir = join(root, 'dist')
const require = createRequire(import.meta.url)

if (!existsSync(join(distDir, 'index.js'))) {
  stdout.write('dist/ is missing. Run "npm run build" first.\n')
  process.exit(1)
}

loadDotEnv(join(root, '.env'))

const accessToken = process.env.NEST_ACCESS_TOKEN?.trim()
if (!accessToken) {
  stdout.write('Set NEST_ACCESS_TOKEN in the environment or in .env (see .env.example).\n')
  process.exit(1)
}

const { openSession } = require(join(distDir, 'api/session.js'))
const { appLaunch, ObjectList } = require(join(distDir, 'api/rest.js'))
const { runObserveSession } = require(join(distDir, 'api/observe.js'))
const { decodeFrame } = require(join(distDir, 'api/protobuf.js'))
const { ObserveState } = require(join(distDir, 'state/observe-state.js'))
const { buildInventory, listDevices } = require(join(distDir, 'state/registry.js'))
const { resolveEndpoints, APP_LAUNCH_BUCKET_TYPES } = require(join(distDir, 'settings.js'))
const { sanitizeError, sanitizeString, sanitizeUrl } = require(join(distDir, 'utils/sanitizers.js'))

const isFieldTest = process.env.NEST_FIELD_TEST === '1'
const listenSeconds = Number(readFlag('listen', '30'))
const isVerbose = process.argv.includes('--verbose')

if (!Number.isFinite(listenSeconds) || listenSeconds < 0) {
  stdout.write('--listen must be a non-negative number of seconds (e.g. --listen 30).\n')
  process.exit(1)
}

const log = {
  debugEnabled: isVerbose,
  debug: (message) => {
    if (isVerbose) {
      stdout.write(`  · ${sanitizeString(message)}\n`)
    }
  },
  info: (message) => stdout.write(`  · ${sanitizeString(message)}\n`),
  warn: (message) => stdout.write(`  ! ${sanitizeString(message)}\n`),
  error: (message) => stdout.write(`  ✗ ${sanitizeString(message)}\n`),
}

function readFlag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function loadDotEnv(path) {
  if (!existsSync(path)) {
    return
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const equals = trimmed.indexOf('=')
    if (equals === -1) {
      continue
    }
    const key = trimmed.slice(0, equals).trim()
    let value = trimmed.slice(equals + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function reportDevice(device) {
  const { identity, state } = device
  const via = identity.sources.observe && identity.sources.rest
    ? 'Observe+REST'
    : identity.sources.observe
      ? 'Observe'
      : 'REST'

  stdout.write(`\n  ${identity.kind.padEnd(18)} ${identity.name}  (${identity.id})  via ${via}\n`)

  if (identity.kind === 'thermostat') {
    stdout.write(
      `    temp=${state.currentTemperatureC ?? '?'}°C  mode=${state.mode ?? '?'}  activity=${state.activity ?? '?'}`
        + `  target=${state.targetTemperatureC ?? '?'}\n`,
    )
    return
  }

  if (identity.kind === 'protect') {
    stdout.write(
      `    smoke=${state.smoke ?? 'unknown'}  CO=${state.carbonMonoxide ?? 'unknown'}`
        + `  online=${state.isOnline ?? '?'}  batteryLow=${state.isBatteryLow ?? '?'}`
        + `  occupancy=${state.occupancySource}`
        + `${state.isOccupied === undefined ? '' : ` occupied=${state.isOccupied}`}\n`,
    )
    return
  }

  stdout.write(
    `    temp=${state.temperatureC ?? '?'}°C  battery=${state.batteryLevel ?? '?'}%\n`,
  )
}

async function main() {
  const endpoints = resolveEndpoints(isFieldTest)
  stdout.write('\n── Session ──\n')
  const session = await openSession({ accessToken, endpoints, log })
  // userid and full transport_url identify the account; print a redacted form.
  stdout.write(`  user ${sanitizeString(`/user/${session.userId}`).replace(/^.*\//, '')}\n`)
  stdout.write(`  transport ${sanitizeUrl(session.transportUrl)}\n`)

  stdout.write('\n── app_launch ──\n')
  const objects = await appLaunch({
    session,
    endpoints,
    bucketTypes: APP_LAUNCH_BUCKET_TYPES,
  })
  const objectList = new ObjectList()
  objectList.merge(objects)
  const buckets = objectList.toBuckets()
  stdout.write(`  ${objectList.size} REST object(s) tracked for subscribe\n`)

  const observe = new ObserveState()
  let frameCount = 0

  if (listenSeconds > 0) {
    stdout.write(`\n── Observe (${listenSeconds}s) ──\n`)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), listenSeconds * 1000)

    try {
      const result = await runObserveSession({
        session,
        endpoints,
        log,
        signal: abort.signal,
        onFrame: (frame) => {
          const decoded = decodeFrame(frame)
          frameCount++
          if (decoded.traits.length > 0) {
            observe.apply(decoded.traits)
          }
        },
      })
      stdout.write(
        `  Observe ended (${result.reason}) after ${result.frameCount} frame(s); decoded ${frameCount}\n`,
      )
    } catch (error) {
      if (abort.signal.aborted) {
        stdout.write(`  stopped after ${listenSeconds}s (${frameCount} frame(s))\n`)
      } else {
        throw error
      }
    } finally {
      clearTimeout(timer)
    }
  }

  stdout.write('\n── Merged inventory ──\n')
  const inventory = buildInventory({
    observe,
    buckets,
    ignoredDeviceIds: new Set(),
  })
  const devices = listDevices(inventory)
  stdout.write(
    `  ${devices.length} device(s):`
      + ` ${inventory.thermostats.size} thermostat(s),`
      + ` ${inventory.protects.size} Protect(s),`
      + ` ${inventory.temperatureSensors.size} temp sensor(s)\n`,
  )

  for (const device of devices) {
    reportDevice(device)
  }

  stdout.write('\nDone (read-only).\n')
  process.exit(0)
}

main().catch((error) => {
  stdout.write(`\nFailed: ${sanitizeError(error)}\n`)
  process.exit(1)
})
