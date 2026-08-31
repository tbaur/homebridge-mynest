# homebridge-mynest detailed documentation

Install and a short options table live in the [README](../README.md). This page is the rest: every option, what HomeKit shows when Nest is quiet, and how to read a failure.

## Table of Contents

- [Full configuration reference](#full-configuration-reference)
- [How devices appear](#how-devices-appear)
- [Protect occupancy](#protect-occupancy)
- [Smoke and CO honesty](#smoke-and-co-honesty)
- [How it works](#how-it-works)
- [Diagnostics](#diagnostics)
- [Troubleshooting](#troubleshooting)
- [Related docs](#related-docs)

## Full configuration reference

```json
{
  "platforms": [
    {
      "platform": "MyNest",
      "name": "MyNest",
      "accessToken": "paste-access_token-from-home.nest.com/session",
      "allowThermostatControl": false,
      "exposeGlobalEcoSwitch": false,
      "exposeProtectOccupancy": true,
      "exposeProtectTemperature": false,
      "ignoredDeviceIds": [],
      "fieldTest": false,
      "diagnosticsInterval": 0,
      "structuredLogs": false,
      "debug": false
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `name` | `MyNest` | Required by Homebridge. Log prefix for this instance. |
| `accessToken` | — | Required. Nest Account `access_token` from [AUTH.md](AUTH.md). Google JWT and `ya29.` shapes are rejected. |
| `allowThermostatControl` | `false` | Opt in to send mode, setpoint, and Eco changes through Nest BatchUpdateState. With this off, HomeKit can still move the tile (Home needs that) but Nest ignores the write and the plugin reverts. |
| `exposeGlobalEcoSwitch` | `false` | Publish a Nest Eco Mode switch that sets Eco on every thermostat. Writes still require `allowThermostatControl`. |
| `exposeProtectOccupancy` | `true` | Occupancy from REST `auto_away` when Nest computes it on a mains-powered Protect. See [Protect occupancy](#protect-occupancy). |
| `exposeProtectTemperature` | `false` | Temperature and humidity measured by each Protect. |
| `ignoredDeviceIds` | `[]` | Device IDs or serials to leave out of HomeKit. |
| `fieldTest` | `false` | Use Nest field-test hosts. |
| `diagnosticsInterval` | `0` | Seconds between health heartbeats in the log. `0` is off. Otherwise `30`–`86400` (24h). |
| `structuredLogs` | `false` | When diagnostics are on, also emit a machine-readable JSON line next to each human summary. |
| `debug` | `false` | Verbose logging. Tokens are redacted. |

`name` is required by Homebridge verified plugins. The plugin uses it as the log prefix.

## How devices appear

| Nest device | HomeKit accessory | Notes |
| --- | --- | --- |
| Thermostat | Thermostat + Eco Mode switch | Observe is source of truth. Modern thermostats may be missing from REST entirely. Mode, setpoints, and Eco are writable only when `allowThermostatControl` is on. Optional house-wide Eco switch via `exposeGlobalEcoSwitch`. |
| Nest Protect | Smoke + CO (+ optional occupancy / temp) | Smoke and CO need REST `topaz`. Battery and online can come from REST and/or Observe. |
| Temperature Sensor | Temperature Sensor | Battery + temperature (`kryptonite`). |

Cameras, doorbells, Yale locks, Home/Away structure switches, and Google-account-only homes are out of scope. That list is also in [SECURITY.md](../SECURITY.md).

A device leaves HomeKit only after Nest-confirmed drops (two-strike and truncation guards on Observe and REST). A cloud blip, a REST-only boot, or an expired access token stops updates but does not unregister thermostats, Protects, or temp sensors. Paste a fresh token and restart.

## Protect occupancy

Nest does not expose a reliable Protect motion event stream to third-party clients.

What this plugin publishes (when REST `auto_away` exists on a mains-powered Protect) is Nest's own presence hold-off: on the order of **ten minutes** after the room empties, clearing when activity is seen again. Do not build automations that expect pathlight-speed motion.

Occupancy is omitted, rather than shown as a stuck empty house, when:

- the Protect is battery-powered
- power is unknown
- the Protect is Observe-only (no REST `auto_away`)
- `exposeProtectOccupancy` is off

If REST later goes stale, a last occupancy reading stays published but is marked inactive/faulted.

## Smoke and CO honesty

Observe-only Protects omit smoke and CO until REST reports alarm state. The accessory still appears, so rooms and automations keep their targets.

If REST later goes down, those tiles stay in HomeKit but are marked inactive/faulted rather than freezing a live all-clear. Battery and online may remain from Observe.

The plugin does not invent an all-clear from unverified Observe fields.

## How it works

Two transports, neither a superset of the other:

| Path | Role |
| --- | --- |
| REST `app_launch` + `/v5/subscribe` | Protect alarm state (`topaz`), structure/where, temperature sensors, older thermostat buckets when present |
| Observe (HTTP/2) | Source of truth for modern thermostats; complete Protect inventory |

The plugin unions Observe ∪ REST and records which transport supplied each device. Independent circuit breakers fail fast when Nest's edge returns sustained 5xx or network failures, then probe again after a short cooldown. Auth and 403 paths keep their own handling.

Architecture and the Homebridge 2 update path: [DEVELOPMENT.md](../DEVELOPMENT.md). Wire-level notes: [PROTOCOL.md](PROTOCOL.md).

## Diagnostics

Set `diagnosticsInterval` to `30`–`86400` to log periodic health heartbeats, plus boot/shutdown snapshots and healthy/degraded transitions. `0` (default) leaves diagnostics off.

`structuredLogs` adds a JSON line next to each human summary. Reports cover REST and Observe transport gauges, breaker state, device inventory, and API latency.

Nothing from diagnostics is exposed in HomeKit.

## Troubleshooting

1. **Authentication error.** Token missing, truncated, Google JWT/`ya29.`, or revoked. Capture a fresh Nest Account token ([AUTH.md](AUTH.md)).
2. **Thermostat missing.** Modern thermostats are Observe-only on some accounts. With default logging the plugin warns within about a minute if Observe produced no frames, and again every five minutes if a connected stream goes quiet. Set `debug: true` for stream detail. From a git checkout you can also run `npm run verify` against the live account. See [DEVELOPMENT.md](../DEVELOPMENT.md).
3. **Thermostat in Settings but no room tile.** Remove and re-add the **MyNest** child bridge in the Home app (or whatever you set as **Name**), then assign rooms again. Same-UUID republish does not clear Apple Home's stuck presentation.
4. **Eco / setpoint changes snap back.** Enable **Allow thermostat control**. With control off, HomeKit can still move the UI (required for tiles) but Nest ignores the write and the plugin reverts.
5. **Protect without smoke/CO.** Likely Observe-only (missing from REST). The accessory still appears; alarm tiles wait for REST.
6. **No occupancy.** Battery Protect, power unknown, Observe-only Protect, or `exposeProtectOccupancy` off. See [Protect occupancy](#protect-occupancy).

Restart Homebridge after any `config.json` edit.

## Related docs

- [README](../README.md): install and short options table
- [AUTH.md](AUTH.md): capturing the Nest Account token
- [PROTOCOL.md](PROTOCOL.md): reverse-engineered Nest behaviour
- [DEVELOPMENT.md](../DEVELOPMENT.md): architecture and local setup
- [SECURITY.md](../SECURITY.md)
- [CONTRIBUTING.md](../CONTRIBUTING.md)

## License

Copyright 2026 tbaur

Licensed under the Apache License, Version 2.0. See [LICENSE](../LICENSE) file for details.
