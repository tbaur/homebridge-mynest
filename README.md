# homebridge-mynest

[![Tests](https://github.com/tbaur/homebridge-mynest/actions/workflows/test.yml/badge.svg)](https://github.com/tbaur/homebridge-mynest/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/homebridge-mynest?style=flat-square)](https://www.npmjs.com/package/homebridge-mynest)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-mynest?style=flat-square)](https://www.npmjs.com/package/homebridge-mynest)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)
[![Homebridge](https://img.shields.io/badge/homebridge-%3E%3D1.6.0%20%7C%7C%202.x-purple)](https://homebridge.io)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Expose Nest thermostats, Nest Protect smoke/CO alarms, and Nest Temperature Sensors in Apple HomeKit through Homebridge, using a **Nest Account** access token only (no Google cookie / `issueToken` auth).

## Features

### Device Support

- **Thermostats** — Current temperature, mode, activity, setpoints, humidity when Nest reports it (read-only in this version)
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
- **Homebridge 2 safe** — Live updates use stored getters + `updateValue(...)`, not removed `getValue()` or stale `.value` reads
- **412 Tests** — Jest suite with an 80% coverage gate across statements, branches, functions, and lines
- **Strict TypeScript** — `strict` mode with unused locals/params and no implicit returns
- **Secret hygiene** — Access tokens are redacted from logs
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

Thermostats, Protects, and temperature sensors appear in the Home app as Nest reports them.

## Supported Devices

| Nest device | HomeKit accessory | Notes |
| --- | --- | --- |
| Thermostat | Thermostat | Read-only; Observe is source of truth |
| Nest Protect | Smoke + CO (+ optional occupancy / temp) | Smoke/CO require REST `topaz`; occupancy is ~10-minute presence |
| Temperature Sensor | Temperature Sensor | Battery + temperature |

Cameras, doorbells, locks, and Home/Away structure switches are out of scope for v1.

## Configuration Options

`name` is required by Homebridge verified plugins and identifies this instance in the logs (defaults to `MyNest`).

| Option | Default | Description |
| --- | --- | --- |
| `name` | `MyNest` | Required. Plugin instance name shown in Homebridge logs. |
| `accessToken` | — | Required. Nest Account `access_token` from [docs/AUTH.md](docs/AUTH.md). |
| `allowThermostatControl` | `false` | Reserved; writes are not supported yet (warns if enabled). |
| `exposeProtectOccupancy` | `true` | Occupancy from REST `auto_away` when Nest computes it on a mains-powered Protect. |
| `exposeProtectTemperature` | `false` | Temperature/humidity measured by each Protect. |
| `ignoredDeviceIds` | `[]` | Device IDs or serials to leave out of HomeKit. |
| `fieldTest` | `false` | Use Nest field-test hosts. |
| `diagnosticsInterval` | `0` | Seconds between health heartbeats in the log; `0` off, else `30`–`3600`. |
| `structuredLogs` | `false` | When diagnostics are enabled, also emit a machine-readable JSON line alongside each human summary. |
| `debug` | `false` | Verbose logging; tokens are redacted. |

## Protect occupancy

Nest does not expose a reliable Protect motion event stream to third-party clients. What this plugin publishes (when REST `auto_away` exists on a mains-powered Protect) is Nest's own presence hold-off — on the order of **ten minutes** after the room empties, clearing when activity is seen again. Do not build automations that expect pathlight-speed motion.

## Not Working?

1. **Authentication error** — Token missing, truncated, Google JWT/`ya29.`, or revoked. Capture a fresh Nest Account token ([docs/AUTH.md](docs/AUTH.md)).
2. **Thermostat missing** — Modern thermostats are Observe-only on some accounts. With default logging the plugin warns within about a minute if Observe produced no frames; set `debug: true` for stream detail, or run `npm run verify`.
3. **Protect without smoke/CO** — Likely Observe-only (missing from REST). The accessory still appears; alarm tiles wait for REST.
4. **No occupancy** — Battery Protect, power unknown, Observe-only Protect, or `exposeProtectOccupancy` off.

## Security

This plugin holds a Nest Account `access_token` in Homebridge's plaintext `config.json`. That token is account-scoped Nest credentials — anyone who can read the file can act as the Nest web app for the home. Secure the host, prefer rotating the token if it may have leaked, and never paste tokens into issues or logs.

Details: [SECURITY.md](SECURITY.md) and [docs/AUTH.md](docs/AUTH.md).

Nest publishes no consumer API and can change or revoke sessions without notice. This plugin uses Nest Account tokens only and rejects Google cookie / `ya29.` shapes on purpose.

## Requirements

- Node.js 20 or newer
- Homebridge 1.6 or newer, including Homebridge 2.x
- A Nest Account (not Google-only) with an `access_token` from [home.nest.com/session](https://home.nest.com/session)

## More Info

- [Authentication](docs/AUTH.md) — capturing the Nest Account token
- [Protocol notes](docs/PROTOCOL.md) — reverse-engineered Nest behaviour
- [Development](DEVELOPMENT.md) — architecture and local setup
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Report issues](https://github.com/tbaur/homebridge-mynest/issues)

## License

Copyright 2026 tbaur

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) file for details.
