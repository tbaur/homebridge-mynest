# homebridge-mynest

[![Tests](https://github.com/tbaur/homebridge-mynest/actions/workflows/test.yml/badge.svg)](https://github.com/tbaur/homebridge-mynest/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/homebridge-mynest?style=flat-square)](https://www.npmjs.com/package/homebridge-mynest)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-mynest?style=flat-square)](https://www.npmjs.com/package/homebridge-mynest)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org)
[![Homebridge](https://img.shields.io/badge/homebridge-2.x-purple)](https://homebridge.io)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Expose Nest thermostats, Nest Protect smoke/CO alarms, and Nest Temperature Sensors in Apple HomeKit through Homebridge, using a **Nest Account** access token only.

## Features

### Device Support

- **Thermostats** — Current temperature, mode, activity, setpoints, humidity when Nest reports it; each thermostat includes an Eco Mode switch; optional house-wide Nest Eco Mode switch (`exposeGlobalEcoSwitch`); HomeKit can change mode/setpoints/Eco when Allow thermostat control is enabled (opt-in)
- **Nest Protect** — Smoke and CO from REST when available; battery / online from REST and/or Observe; optional occupancy and Protect temperature
- **Temperature Sensors** — Nest Temperature Sensor (kryptonite) pucks
- **Dual transport** — Merges Nest REST subscribe with HTTP/2 Observe so Observe-only devices still appear

### Honesty about Nest's APIs

- **Occupancy is not motion** — Nest publishes `auto_away` for mains-powered Protects: roughly a ten-minute presence verdict. Battery Protects, power-unknown Protects, and Observe-only Protects get no occupancy sensor rather than a stuck "empty house"; when REST later goes stale, a last occupancy reading stays published but is marked inactive/faulted
- **Smoke/CO honesty without accessory churn** — Observe-only Protects omit smoke/CO until REST reports alarm state; if REST later goes down, tiles stay in HomeKit (rooms/automations keep their targets) but are marked inactive/faulted rather than freezing a live all-clear. Battery and online may remain from Observe
- **Thermostats are Observe-first** — Modern Nest thermostats may be missing from REST entirely; this plugin does not rely on REST-only discovery for HVAC

### Reliability

- **No accessory churn on outages or token expiry** — Devices leave HomeKit only after Nest-confirmed drops (two-strike + truncation guards on Observe and REST). A cloud blip, REST-only boot, or expired access token stops updates but does not unregister thermostats, Protects, or temp sensors (paste a fresh token and restart)
- **Circuit breakers** — Independent REST and Observe breakers fail fast when Nest's edge is returning sustained 5xx / network failures, then probe again after a short cooldown (auth and 403 paths keep their own handling)
- **Diagnostics** *(optional)* — Opt-in health/activity heartbeats, boot/shutdown snapshots, and healthy/degraded transitions in the Homebridge log (REST + Observe transport gauges, breaker state, device inventory, API latency)

### Quality

<!-- Canonical test count lives here only; keep other docs number-free to avoid multi-place updates. -->
- **Built for Homebridge 2** — Live updates use stored getters + `updateValue(...)`, not the removed `getValue()` or stale `.value` reads
- **556 Tests** — Jest suite gated on 92% statements / 83% branches globally, plus per-area floors, and verified to leave no open handles
- **Strict TypeScript** — `strict` mode with unused locals/params and no implicit returns, plus type-aware linting (no floating promises)
- **Secret hygiene** — Access tokens are redacted from logs, and untrusted Nest responses cannot reach `Object.prototype`
- **No analytics** — Zero tracking or data collection

## Quick Start

### 1. Install

**Homebridge UI** (recommended): Plugins → Search `mynest` → Install

**Command line:**

```bash
npm install -g homebridge-mynest
```

### 2. Get a Nest Account token

You need a Nest Account (not Google-only) access token from [home.nest.com/session](https://home.nest.com/session). Steps and threat model: [docs/AUTH.md](docs/AUTH.md).

Prefer treating that token like a password; Nest Account sessions are account-scoped credentials.

### 3. Configure

Use the Homebridge UI, or add the platform to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "MyNest",
      "name": "MyNest",
      "accessToken": "paste-access_token-from-home.nest.com/session"
    }
  ]
}
```

### 4. Restart Homebridge

Thermostats, Protects, and temperature sensors appear in the Home app as Nest reports them. The log should show `Connected to Nest (REST up; Observe connecting)`, then device adds, then `Platform ready`.

Thermostat control (mode, setpoints, Eco) stays off until you enable **Allow thermostat control**. Optionally enable **Expose global Eco switch** for a house-wide Nest Eco Mode tile.

## Supported Devices

| Nest device | HomeKit accessory | Notes |
| --- | --- | --- |
| Thermostat | Thermostat + Eco Mode switch | Observe is source of truth; mode/setpoints/Eco writable when `allowThermostatControl` is on (opt-in). Optional house-wide Eco switch via `exposeGlobalEcoSwitch`. |
| Nest Protect | Smoke + CO (+ optional occupancy / temp) | Smoke/CO require REST `topaz`; occupancy is ~10-minute presence |
| Temperature Sensor | Temperature Sensor | Battery + temperature |

Cameras, doorbells, Yale locks, Home/Away structure switches, and Google-account-only homes are out of scope.

## Configuration Options

`name` is required by Homebridge verified plugins and identifies this instance in the logs (defaults to `MyNest`).

| Option | Default | Description |
| --- | --- | --- |
| `name` | `MyNest` | Required. Plugin instance name shown in Homebridge logs. |
| `accessToken` | — | Required. Nest Account `access_token` from [docs/AUTH.md](docs/AUTH.md). |
| `allowThermostatControl` | `false` | Opt in to send mode/setpoint/Eco changes to Nest via BatchUpdateState. |
| `exposeGlobalEcoSwitch` | `false` | Publish a Nest Eco Mode switch that sets Eco on every thermostat. Writes require `allowThermostatControl`. |
| `exposeProtectOccupancy` | `true` | Occupancy from REST `auto_away` when Nest computes it on a mains-powered Protect. |
| `exposeProtectTemperature` | `false` | Temperature/humidity measured by each Protect. |
| `ignoredDeviceIds` | `[]` | Device IDs or serials to leave out of HomeKit. |
| `fieldTest` | `false` | Use Nest field-test hosts. |
| `diagnosticsInterval` | `0` | Seconds between health heartbeats in the log; `0` off, else `30`–`86400` (24h). |
| `structuredLogs` | `false` | When diagnostics are enabled, also emit a machine-readable JSON line alongside each human summary. |
| `debug` | `false` | Verbose logging; tokens are redacted. |

## Protect occupancy

Nest does not expose a reliable Protect motion event stream to third-party clients. What this plugin publishes (when REST `auto_away` exists on a mains-powered Protect) is Nest's own presence hold-off — on the order of **ten minutes** after the room empties, clearing when activity is seen again. Do not build automations that expect pathlight-speed motion.

## Not Working?

1. **Authentication error** — Token missing, truncated, Google JWT/`ya29.`, or revoked. Capture a fresh Nest Account token ([docs/AUTH.md](docs/AUTH.md)).
2. **Thermostat missing** — Modern thermostats are Observe-only on some accounts. With default logging the plugin warns within about a minute if Observe produced no frames, and again every five minutes if a connected stream goes quiet; set `debug: true` for stream detail. From a git checkout you can also run `npm run verify` against the live account — see [DEVELOPMENT.md](DEVELOPMENT.md).
3. **Thermostat in Settings but no room tile** — Remove and re-add the **MyNest** child bridge in the Home app (or whatever you set as **Name**), then assign rooms again. Same-UUID republish does not clear Apple Home's stuck presentation.
4. **Eco / setpoint changes snap back** — Enable **Allow thermostat control**. With control off, HomeKit can still move the UI (required for tiles) but Nest ignores the write and the plugin reverts.
5. **Protect without smoke/CO** — Likely Observe-only (missing from REST). The accessory still appears; alarm tiles wait for REST.
6. **No occupancy** — Battery Protect, power unknown, Observe-only Protect, or `exposeProtectOccupancy` off.

## Security

This plugin holds a Nest Account `access_token` in Homebridge's plaintext `config.json`. That token is account-scoped Nest credentials — anyone who can read the file can act as the Nest web app for the home. Secure the host, prefer rotating the token if it may have leaked, and never paste tokens into issues or logs.

Details: [SECURITY.md](SECURITY.md) and [docs/AUTH.md](docs/AUTH.md).

Nest publishes no consumer API and can change or revoke sessions without notice. This plugin uses Nest Account tokens only and rejects Google cookie / `ya29.` shapes on purpose.

## Requirements

- **Homebridge 2.x** — Homebridge 1.x is not supported
- **Node.js 22 or newer.** Homebridge 2 itself currently supports Node 22 and 24, which is what CI tests against
- A Nest Account (not Google-only) with an `access_token` from [home.nest.com/session](https://home.nest.com/session)

## More Info

- [Authentication](docs/AUTH.md) — capturing the Nest Account token
- [Protocol notes](docs/PROTOCOL.md) — reverse-engineered Nest behaviour
- [Development](DEVELOPMENT.md) — architecture and local setup
- [Contributing](CONTRIBUTING.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Report issues](https://github.com/tbaur/homebridge-mynest/issues)

## License

Copyright 2026 tbaur

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) file for details.
