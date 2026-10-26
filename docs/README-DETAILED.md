# homebridge-mynest detailed documentation

Install and a short options table live in the [README](../README.md). This page is the rest: every option, what HomeKit shows when Nest is quiet, and how to read a failure.

## Table of Contents

- [Full configuration reference](#full-configuration-reference)
- [How devices appear](#how-devices-appear)
- [Protect occupancy](#protect-occupancy)
- [Smoke and CO honesty](#smoke-and-co-honesty)
- [How it works](#how-it-works)
- [Diagnostics](#diagnostics)
- [PagerDuty](#pagerduty)
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
      "pagerdutySignals": false,
      "debug": false
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `name` | `MyNest` | Required by Homebridge. Log prefix for this instance. |
| `accessToken` | — | Required. Nest Account `access_token` from [AUTH.md](AUTH.md). Google JWT and `ya29.` shapes are rejected. |
| `allowThermostatControl` | `false` | Opt in to send mode, setpoint, and Eco changes through Nest BatchUpdateState. With this off, HomeKit can still move the tile (Home needs that), but the plugin does not send the change to Nest and moves the tile back. |
| `exposeGlobalEcoSwitch` | `false` | Publish a Nest Eco Mode switch that sets Eco on every thermostat. Writes still require `allowThermostatControl`. |
| `exposeProtectOccupancy` | `true` | Occupancy from REST `auto_away` when that field is a boolean and the Protect is not reported as battery-powered. Unknown power does not hide a boolean Nest already sent. See [Protect occupancy](#protect-occupancy). |
| `exposeProtectTemperature` | `false` | Temperature and humidity measured by each Protect. |
| `ignoredDeviceIds` | `[]` | Device IDs or serials to leave out of HomeKit. |
| `fieldTest` | `false` | Use Nest field-test hosts. |
| `diagnosticsInterval` | `0` | Seconds between health heartbeats in the log. `0` is off. Otherwise `30`–`86400` (24h). |
| `structuredLogs` | `false` | When diagnostics are on, also emit a machine-readable JSON line next to each human summary. |
| `pagerdutySignals` | `false` | Write alert conditions to homebridge-pagerduty's signal store. See [PagerDuty](#pagerduty). |
| `debug` | `false` | Verbose logging. Tokens are redacted. |

`name` is required by Homebridge verified plugins. The plugin uses it as the log prefix.

## How devices appear

| Nest device | HomeKit accessory | Notes |
| --- | --- | --- |
| Thermostat | Thermostat + Eco Mode switch | Observe is source of truth. Modern thermostats may be missing from REST entirely. Mode, setpoints, and Eco are writable only when `allowThermostatControl` is on. Optional house-wide Eco switch via `exposeGlobalEcoSwitch`. Until Nest reports a temperature, the tile uses 20°C instead of HomeKit's 0°C default. A later real 0°C is kept. When the thermostat follows a Temperature Sensor, its current temperature updates with that sensor. |
| Nest Protect | Smoke + CO (+ optional occupancy / temp) | Both sensors are always published. A missing REST number faults that sensor. Battery-low status can still come from Observe. The smoke and CO tiles stay inactive while that sensor has no REST number or the REST feed is stale, including when Observe says the Protect is online. |
| Temperature Sensor | Temperature Sensor | Battery + temperature (`kryptonite`). A missing temperature faults the sensor. HomeKit's 0°C default is not a reading. |

Cameras, doorbells, Yale locks, Home/Away structure switches, and Google-account-only homes are out of scope. That list is also in [SECURITY.md](../SECURITY.md).

A device leaves HomeKit only after Nest-confirmed drops (two-strike and truncation guards on Observe and REST). After a restart, a cached device that Nest has not named yet stays until two settled Observe snapshots both omit it. A cloud blip, a REST-only boot, or an expired access token stops updates but does not unregister thermostats, Protects, or temp sensors. Paste a fresh token and restart.

## Protect occupancy

Nest does not expose a reliable Protect motion event stream to third-party clients.

What this plugin publishes, when REST `auto_away` is a boolean and the Protect is not reported as battery-powered, is Nest's own presence hold-off: on the order of **ten minutes** after the room empties, clearing when activity is seen again. `auto_away` false is Occupied. Do not build automations that expect pathlight-speed motion.

Occupancy is omitted, rather than shown as a stuck empty house, when:

- the Protect is battery-powered (REST `line_power_present` false, or, when REST omits that field, an Observe `wall_power` trait that does not report `present`)
- REST lists the Protect and omits `auto_away`
- the Protect is Observe-only (no REST `auto_away`)
- `exposeProtectOccupancy` is off

Unknown power is not a reason to omit occupancy when `auto_away` is already a boolean. Each omission is logged once at info.

If REST later goes stale, a last occupancy reading stays published but is marked inactive and faulted.

Each Protect logs a summary at info when its state changes, such as `Zone One Protect: Smoke ok, CO ok, Occupied`. With `debug` on, every REST object for a Protect also logs the raw fields, `REST topaz auto_away=... smoke_status=... co_status=...`. `absent` means Nest did not send that field.

## Smoke and CO honesty

Every Protect publishes a smoke sensor and a CO sensor. A live REST `smoke_status` or `co_status` of `0` is clear. `1` and any greater integer is detected, including Nest's heads-up value `1`. A negative number, a non-integer, or a missing value faults that sensor and does not write a clear.

The service stays, so rooms and automations keep their targets. An Observe-only Protect is that case until REST reports a number.

If REST later goes down, those tiles stay in HomeKit with the last value, marked inactive and faulted. An `app_launch` that is empty or under half the previous object count does not count as that refresh. Battery-low status can still come from Observe. The smoke and CO tiles stay inactive while the REST feed is stale, including when Observe says the Protect is online.

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

Set `diagnosticsInterval` to `30`–`86400` to log periodic health heartbeats and boot/shutdown snapshots. The heartbeat where health flips from healthy to degraded is a warning; later degraded heartbeats stay at info until it recovers. `0` (default) leaves diagnostics off.

`structuredLogs` adds a JSON line next to each human summary. Reports cover REST and Observe transport gauges, breaker state, device inventory, and API latency.

Nothing from diagnostics is exposed in HomeKit.

## PagerDuty

This plugin can page through [homebridge-pagerduty](https://github.com/tbaur/homebridge-pagerduty) when something needs attention. It needs Node 22.13 or later.

1. Turn on **Send Signals to PagerDuty** (`pagerdutySignals`) in this plugin's settings.
2. Restart Homebridge.
3. In homebridge-pagerduty's settings, allow homebridge-mynest to page, save, and restart Homebridge again. [Signals from other plugins](https://github.com/tbaur/homebridge-pagerduty/blob/main/docs/SIGNALS.md#let-a-plugin-page) explains each step and what else you can set for each signal.

Each condition below then opens a PagerDuty alert while it is present, and resolves it when it clears.

| Signal | Severity | Active when |
| --- | --- | --- |
| `smoke` | critical | Any Protect reports a smoke warning or emergency |
| `co` | critical | Any Protect reports a carbon monoxide warning or emergency |
| `alarm-feed-stale` | error | The Protect alarm feed has been unavailable for 5 minutes, whatever the cause, so HomeKit may not show a smoke or CO alarm |
| `auth-failed` | error | The plugin stopped because Nest rejected the token (HTTP 400 or 401), the token in the config is missing or invalid, or Nest changed its session format |

Each signal covers the whole house. The summary does not name the Protect, so check the Nest app for which one is alarming. While the alarm feed is stale, `smoke` and `co` keep their last value. They do not clear until fresh readings arrive. While `auth-failed` is active, `alarm-feed-stale` stays off, so a stopped plugin sends one page. Any other failure, such as HTTP 403, an unfamiliar error code or a network outage, keeps retrying and pages `alarm-feed-stale` if it lasts 5 minutes. The plugin writes `auth-failed` and `alarm-feed-stale` at startup, so homebridge-pagerduty lists it even if Nest never answers.

## Troubleshooting

1. **Authentication error.** Token missing, truncated, Google JWT/`ya29.`, or revoked. Capture a fresh Nest Account token ([AUTH.md](AUTH.md)).
2. **Thermostat missing.** Modern thermostats are Observe-only on some accounts. With default logging the plugin warns within about a minute if Observe produced no frames, and again every five minutes if a connected stream goes quiet. Set `debug: true` for stream detail. From a git checkout you can also run `npm run verify` against the live account. See [DEVELOPMENT.md](../DEVELOPMENT.md).
3. **Thermostat in Settings but no room tile.** Remove and re-add the **MyNest** child bridge in the Home app (or whatever you set as **Name**), then assign rooms again. Same-UUID republish does not clear Apple Home's stuck presentation.
4. **Eco / setpoint changes snap back.** Enable **Allow thermostat control**. With control off, HomeKit can still move the UI (required for tiles), but the plugin does not send the change to Nest and moves the tile back.
5. **Protect smoke or CO shows a fault.** REST has no number for that sensor yet, or the REST feed is stale. The tile stays. Turn on `debug` and search the log for `REST topaz` to see the raw `smoke_status` and `co_status`.
6. **No occupancy, or Occupied in an empty room.** Occupancy is `auto_away` inverted. It is omitted for a battery Protect, a missing `auto_away`, an Observe-only Protect, or `exposeProtectOccupancy` off. A room that stays Occupied never logs a later summary with `Unoccupied`. With `debug` on, each `REST topaz` line for it shows `auto_away=false`. See [Protect occupancy](#protect-occupancy).

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
