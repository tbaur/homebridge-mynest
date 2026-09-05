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
- **Nest Protect:** smoke and CO from REST when available; battery and online from REST and/or Observe
- **Optional Protect occupancy and temperature**
- **Temperature Sensors:** Nest Temperature Sensor (kryptonite) pucks
- **Dual transport:** Nest REST subscribe merged with HTTP/2 Observe, so Observe-only devices still appear

### Reliability
- **No accessory churn** on a cloud blip or expired token. Devices leave HomeKit only after Nest-confirmed drops
- **Circuit breakers** on REST and Observe so a dead Nest edge fails fast
- **Diagnostics** *(optional):* health heartbeats and healthy/degraded transitions in the Homebridge log

### Quality
<!-- Canonical test count lives here only; keep other docs number-free to avoid multi-place updates. -->
- **576 tests** with a per-area coverage floor, and a CI step that fails if the suite leaks an open handle
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
| Nest Protect | Smoke + CO (+ optional occupancy / temp) | Smoke/CO require REST `topaz`. Occupancy is ~10-minute presence, not motion. |
| Temperature Sensor | Temperature Sensor | Battery + temperature |

Cameras, doorbells, Yale locks, Home/Away structure switches, and Google-account-only homes are out of scope.

## Configuration Options

`name` is required by Homebridge verified plugins and identifies this instance in the logs (defaults to `MyNest`).

| Option | Default | Description |
| --- | --- | --- |
| `name` | `MyNest` | Required. Plugin instance name in Homebridge logs. |
| `accessToken` | — | Required. Nest Account `access_token`. See [docs/AUTH.md](docs/AUTH.md). |
| `allowThermostatControl` | `false` | Send mode/setpoint/Eco changes to Nest. |
| `exposeGlobalEcoSwitch` | `false` | One switch that sets Eco on every thermostat. Writes still need `allowThermostatControl`. |
| `exposeProtectOccupancy` | `true` | Occupancy from REST `auto_away` on a mains-powered Protect. |
| `exposeProtectTemperature` | `false` | Temperature/humidity measured by each Protect. |
| `ignoredDeviceIds` | `[]` | Device IDs or serials to leave out of HomeKit. |
| `fieldTest` | `false` | Use Nest field-test hosts. |
| `diagnosticsInterval` | `0` | Seconds between health heartbeats; `0` off, else `30`–`86400`. |
| `structuredLogs` | `false` | With diagnostics, also emit a JSON line. |
| `debug` | `false` | Verbose logging; tokens are redacted. |

The [detailed documentation](docs/README-DETAILED.md#full-configuration-reference) explains each option and what happens when REST or Observe is down.

## Not Working?

1. **Authentication error:** token missing, truncated, Google JWT/`ya29.`, or revoked. Capture a fresh Nest Account token ([docs/AUTH.md](docs/AUTH.md)).
2. **Thermostat missing:** modern thermostats are Observe-only on some accounts. Enable `debug` for stream detail.
3. **Eco / setpoint changes snap back:** enable **Allow thermostat control**.
4. **Protect without smoke/CO:** likely Observe-only. The accessory still appears; alarm tiles wait for REST.
5. **No occupancy:** battery Protect, power unknown, Observe-only, or `exposeProtectOccupancy` off. Occupancy is not motion.

The [full troubleshooting list](docs/README-DETAILED.md#troubleshooting) covers more cases, including a stuck Home app tile.

## Security

This plugin holds a Nest Account `access_token` in Homebridge's plaintext `config.json`. Anyone who can read that file can act as the Nest web app for the home. Secure the host, rotate the token if it may have leaked, and never paste tokens into issues or logs.

See [SECURITY.md](SECURITY.md) and [docs/AUTH.md](docs/AUTH.md).

## Requirements

- **Homebridge 2.x** (Homebridge 1.x is not supported)
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

## License

Copyright 2026 tbaur

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) file for details.
