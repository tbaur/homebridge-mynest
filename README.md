# homebridge-mynest

[![Tests](https://github.com/tbaur/homebridge-mynest/actions/workflows/test.yml/badge.svg)](https://github.com/tbaur/homebridge-mynest/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/homebridge-mynest?style=flat-square)](https://www.npmjs.com/package/homebridge-mynest)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-mynest?style=flat-square)](https://www.npmjs.com/package/homebridge-mynest)
[![Node.js](https://img.shields.io/badge/node-22%20%7C%7C%2024%20%7C%7C%2026-green)](https://nodejs.org)
[![Homebridge](https://img.shields.io/badge/homebridge-2.x-purple)](https://homebridge.io)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Expose Nest thermostats, Nest Protect smoke/CO alarms, and Nest Temperature Sensors in Apple HomeKit through Homebridge, using a **Nest Account** access token only.

## Features

### Device Support
- **Thermostats:** temperature, mode, activity, setpoints, humidity when Nest reports it, plus an Eco Mode switch per thermostat
- **Optional house-wide Eco switch:** `exposeGlobalEcoSwitch`
- **Thermostat writes:** mode, setpoints, and Eco only when **Allow thermostat control** is on (off by default)
- **Nest Protect:** smoke and CO sensors on every Protect. A missing REST reading is a fault, not a missing tile. Battery-low status can still come from Observe. The smoke and CO tiles stay inactive while that sensor has no REST number or the REST feed is stale, including when Observe says the Protect is online
- **Optional Protect occupancy and temperature**
- **Temperature Sensors:** Nest Temperature Sensor (kryptonite) pucks
- **Dual transport:** Nest REST subscribe merged with HTTP/2 Observe, so Observe-only devices still appear

### Reliability
- **No accessory churn** on a cloud blip or expired token. Devices leave HomeKit only after Nest-confirmed drops
- **Circuit breakers** on REST and Observe so a dead Nest edge fails fast
- **Diagnostics** *(optional):* health heartbeats in the Homebridge log, with one warning when health becomes degraded

### Quality
<!-- Canonical test count lives here only; keep other docs number-free to avoid multi-place updates. -->
- A per-area test coverage floor, and a CI step that fails if the suite leaks an open handle
- **Built for Homebridge 2:** stored getters and `updateValue(...)`, not the removed `getValue()`
- **Secret hygiene:** access tokens are redacted from logs
- **No analytics**

Every option, occupancy caveat, and troubleshooting step is in [Detailed documentation](docs/README-DETAILED.md).

## Quick Start

### 1. Install

**Homebridge UI** (recommended): Plugins → Search `mynest` → Install

```bash
npm install -g homebridge-mynest
```

### 2. Get a Nest Account token

You need a Nest Account (not Google-only) access token from [home.nest.com/session](https://home.nest.com/session). Steps and threat model: [docs/AUTH.md](docs/AUTH.md).

Treat that token like a password. Nest Account sessions are account-scoped credentials.

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

Thermostat control stays off until you enable **Allow thermostat control**. Optionally enable **Expose global Eco switch**.

## Supported Devices

| Nest device | HomeKit accessory | Notes |
| --- | --- | --- |
| Thermostat | Thermostat + Eco Mode switch | Observe is source of truth. Writes need `allowThermostatControl`. |
| Nest Protect | Smoke + CO (+ optional occupancy / temp) | Smoke and CO stay published. A missing REST number faults that sensor. Occupancy is ~10-minute presence, not motion. |
| Temperature Sensor | Temperature Sensor | Battery + temperature. A missing temperature faults the sensor. |

Cameras, doorbells, Yale locks, Home/Away structure switches, and Google-account-only homes are out of scope.

## Configuration Options

`name` is required by Homebridge verified plugins and identifies this instance in the logs (defaults to `MyNest`).

| Option | Default | Description |
| --- | --- | --- |
| `name` | `MyNest` | Required. Plugin instance name in Homebridge logs. |
| `accessToken` | — | Required. Nest Account `access_token`. See [docs/AUTH.md](docs/AUTH.md). |
| `allowThermostatControl` | `false` | Send mode/setpoint/Eco changes to Nest. |
| `exposeGlobalEcoSwitch` | `false` | One switch that sets Eco on every thermostat. Writes still need `allowThermostatControl`. |
| `exposeProtectOccupancy` | `true` | Occupancy from REST `auto_away` when that field is a boolean and the Protect is not reported as battery-powered. Unknown power does not hide a boolean Nest already sent. |
| `exposeProtectTemperature` | `false` | Temperature/humidity measured by each Protect. |
| `ignoredDeviceIds` | `[]` | Device IDs or serials to leave out of HomeKit. |
| `fieldTest` | `false` | Use Nest field-test hosts. |
| `diagnosticsInterval` | `0` | Seconds between health heartbeats; `0` off, else `30`–`86400`. |
| `structuredLogs` | `false` | With diagnostics, also emit a JSON line. |
| `pagerdutySignals` | `false` | Page through homebridge-pagerduty. Off until turned on. See [PagerDuty](docs/README-DETAILED.md#pagerduty). |
| `debug` | `false` | Verbose logging; tokens are redacted. |

The [detailed documentation](docs/README-DETAILED.md#full-configuration-reference) explains each option and what happens when REST or Observe is down.

## Not Working?

1. **Authentication error:** token missing, truncated, Google JWT/`ya29.`, or revoked. Capture a fresh Nest Account token ([docs/AUTH.md](docs/AUTH.md)).
2. **Thermostat missing:** modern thermostats are Observe-only on some accounts. Enable `debug` for stream detail.
3. **Eco / setpoint changes snap back:** enable **Allow thermostat control**.
4. **Protect smoke/CO shows a fault:** REST has not supplied that sensor's number, or the REST feed is stale. The tile stays. A line `REST topaz auto_away=... smoke_status=... co_status=...` is the raw reading, including when the summary sentence did not change.
5. **No occupancy, or a room that stays Occupied:** occupancy is Nest's `auto_away` inverted (false means Occupied), not motion. It is omitted for a battery Protect, when `auto_away` is missing, or when `exposeProtectOccupancy` is off. A stuck Occupied is that boolean staying false. The `REST topaz` line shows the raw value each time a Protect object arrives.

The [full troubleshooting list](docs/README-DETAILED.md#troubleshooting) covers more cases, including a stuck Home app tile.

## Security

This plugin holds a Nest Account `access_token` in Homebridge's plaintext `config.json`. Anyone who can read that file can act as the Nest web app for the home. Secure the host, rotate the token if it may have leaked, and never paste tokens into issues or logs.

See [SECURITY.md](SECURITY.md) and [docs/AUTH.md](docs/AUTH.md).

## Requirements

- **Homebridge 2.x**
- **Node.js 22, 24, or 26**
- A Nest Account (not Google-only) with an `access_token` from [home.nest.com/session](https://home.nest.com/session)

## More Info

- [Detailed documentation](docs/README-DETAILED.md)
- [Authentication](docs/AUTH.md)
- [Protocol notes](docs/PROTOCOL.md)
- [Development](DEVELOPMENT.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Report issues](https://github.com/tbaur/homebridge-mynest/issues)

## Trademarks

homebridge-mynest is an independent project. It is not affiliated with or endorsed by Google. Nest, Nest Protect, and Nest Temperature Sensor are trademarks of Google LLC.

## License

Copyright 2026 tbaur

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) file for details.
