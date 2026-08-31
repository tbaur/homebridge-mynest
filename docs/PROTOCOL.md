# Protocol notes

User-facing options and troubleshooting: [README-DETAILED.md](README-DETAILED.md). Token capture: [AUTH.md](AUTH.md).

Nest publishes no consumer API. Everything below was confirmed with a probe kit against a live Nest Account. Treat this as a working map of private backends, not a promise Nest will keep them stable.

## Dual transport

| Path | Role |
| --- | --- |
| REST `app_launch` + `/v5/subscribe` | Protect alarm state (`topaz`), structure/where, temperature sensors (`kryptonite`), older thermostat buckets when present |
| Observe (HTTP/2 gRPC-web protobuf) | Source of truth for modern thermostats; complete Protect inventory; trait patches for HVAC |

Neither transport is a superset of the other. On the account used to build this plugin, REST returned six Protects and zero thermostats while Observe returned seven Protects and five thermostats — and REST still claimed `num_thermostats: "5+"`. The plugin unions Observe ∪ REST and records which transport supplied each device.

**Critical merge rule:** Observe is authoritative for thermostats and for the complete Protect list. One Protect (post-reset) can be Observe-only and missing from REST `topaz`/`swarm`; it must still appear in HomeKit.

## Accessory removal

HomeKit accessories are unregistered only when Nest has confirmed a device is gone — never because a transport errored, a breaker opened, or a boot raced REST ahead of Observe.

| Signal | Behaviour |
| --- | --- |
| Failed REST / Observe request | Keep last inventory; no unregister |
| REST `app_launch` empty or under half prior size | Treat as truncated; merge present keys; keep missing |
| REST `app_launch` omits a key | Two consecutive complete omissions before drop |
| Observe reconnect empty or under half prior devices | Treat as incomplete; keep prior Observe state |
| Observe omits a `DEVICE_*` | Two consecutive complete snapshots before prune |
| Observe never connected this session | Do not unregister (REST-only view cannot prove thermostats are gone) |
| Device absent from the Observe ∪ REST inventory after the above | Unregister from HomeKit |
| Expired / revoked access token (or both transports exhausted on HTTP 403) | Stop updates; **keep** accessories — Nest Account auth is a manually pasted session token, so unregistering would bounce rooms/automations until the user pastes a fresh one and restarts |

Unusable plugin config at startup (missing/invalid token shape, etc.) **keeps** the cached accessories, for the same reason an expired token does. A typo, a half-edited `config.json`, or a truncated token would otherwise destroy every room assignment, scene membership, and automation target in the Home app — and fixing the config does not bring them back, because HomeKit treats the re-registered accessories as new devices. A config error cannot warrant a more destructive response than a revoked token. The plugin logs why and publishes nothing until it is restarted with a usable config.

A transient failure at startup (DNS, TLS, a timeout, a 5xx) is **not** fatal: it is retried with backoff, because `didFinishLaunching` fires only once and a host that boots before its network is up would otherwise stay idle for the lifetime of the process.

## Session

1. Config holds Nest Account `access_token` from `https://home.nest.com/session`.
2. Plugin calls `GET /session` with `Authorization: Basic <token>` and the web app's `cztoken` cookie.
3. Response yields session `access_token`, `userid`, and `urls.transport_url`.
4. REST calls use Basic auth with the session token; Observe uses the same token against `grpc-web.production.nest.com`.

## REST

- `POST /api/0.1/user/{userid}/app_launch` with bucket types including `topaz`, `structure`, `kryptonite`, `device`, `shared`, `where`, …
- Long-poll: `POST {transport_url}/v5/subscribe` with `{ objects: [{ object_key, object_revision, object_timestamp }] }`, client timeout ~120s. An idle abort is normal, not a failure.

## Observe

- Host: `grpc-web.production.nest.com`, path from session endpoints (`GatewayService/Observe`).
- Request body: opaque traits blob vendored from the probe kit (`assets/protobuf/ObserveTraits.protobuf`).
- Framing: length-delimited `nest.rpc.StreamBody`. Decode the full framed buffer; do not strip a header and assume success.
- Frame 0 is often a resource/trait catalog that fails NestMessage decode — ignore it.
- Later frames are trait snapshots/patches. Nest sends deltas; merge patches into state.

## Protect occupancy

A Protect has a PIR sensor, but neither API exposes usable motion events in practice. A ~12.5-hour capture of both transports on an occupied house recorded zero REST `auto_away` flips and zero nonempty Observe `ambient_motion` deltas. Many false "MOTION" banners in naive parsers were reconnect baselines containing the schema string `AmbientMotionEvent`, not live PIR.

What Nest does publish is `auto_away` on mains-powered Protects in REST `topaz`: roughly a ten-minute presence hold-off (`auto_away_decision_time_secs` is the window constant, not a timestamp). HomeKit occupancy is therefore:

- Published only when REST `auto_away` exists **and** the unit is confirmed mains-powered (`line_power_present` / Observe `wall_power`).
- Unavailable when power is unknown, for battery Protects, and for Observe-only Protects until a real event path is proven.
- Documented as presence, not pathlight-speed motion.

## Protect smoke / CO

Alarm status is taken from REST `topaz` (`smoke_status` / `co_status`), and only while the REST feed can refresh it. Observe streams `safety_alarm_*` traits, but no public schema maps them and captured samples have all been all-clear. Inferring "no smoke" from an unverified enum is refused.

An Observe-only Protect gets no smoke/CO HomeKit services until REST reports alarm state. If REST later becomes unavailable (circuit breaker open, HTTP 403 budget exhausted, or no successful subscribe/`app_launch` within the stale window), smoke/CO services stay published with last-known values but `StatusActive=false` and `StatusFault=GENERAL_FAULT` — leaving a frozen clear that still looks live would be dishonest, and tearing services down would break HomeKit rooms and automations on every Nest blip. Battery / online may still appear from Observe.

## Thermostat writes

HVAC state updates arrive over Observe (`target_temperature_settings` / `hvac_control` / `eco_mode_state`). Writes use the same protobuf gateway as the Nest web app:

### Mode / setpoints

1. Encode `nest.trait.hvac.TargetTemperatureSettingsTrait` (mode via `settings.hvacMode` + `active`; setpoints as `targetTemperatureHeat` / `targetTemperatureCool`).
2. Wrap in `nest.rpc.NestMessage` `{ set: [{ object: { id: DEVICE_…, key: target_temperature_settings, uuid }, property: Any }] }`.
3. `POST https://grpc-web.production.nest.com/nestlabs.gateway.v1.TraitBatchApi/BatchUpdateState` with `Content-Type: application/x-protobuf` and the session Basic token.

`off` is `active=0` with a standby `HEAT`/`COOL` left in `hvacMode` — Nest does not store an OFF enum there. REST `/v5/put` cannot reach Observe-only thermostats.

Plugin flag: `allowThermostatControl` (default **off**). Manual HomeKit setpoint/mode writes clear Nest Eco (`eco_mode_state` OFF) in the same batch when Eco was active.

> The encode shape was confirmed against a live account with a maintainer-only probe kit (`nest-probe`), which is **not part of this repository** and is not something a user or contributor can run. Treat references to it as provenance for where these findings came from, not as a step to reproduce.

### Eco Mode (on / off)

HomeKit has no Eco thermostat mode, so the plugin exposes Eco as a Switch (per thermostat, plus optional house-wide `exposeGlobalEcoSwitch`). Writes are a separate BatchUpdateState body:

1. Encode `nest.trait.hvac.EcoModeStateTrait` with `ecoEnabled` `ON` or `OFF` and `ecoModeChangeReason` `ECO_MODE_CHANGE_REASON_MANUAL`.
2. Wrap in `nest.rpc.NestMessage` `{ set: [{ object: { id: DEVICE_…, key: eco_mode_state, uuid }, property: Any }] }` (`encodeEcoModeBatchUpdate`).
3. Same `TraitBatchApi/BatchUpdateState` endpoint and auth as setpoint writes.

Eco-only writes were never confirmed against a live account the way setpoints were; enable `allowThermostatControl` only if you are comfortable with live Nest writes on your account.

The optional house-wide switch (`exposeGlobalEcoSwitch`) posts Eco to every live thermostat accessory. It reports success only when every write succeeds; HomeKit stays optimistic until Nest's all-Eco aggregate matches (or 45s elapses and Nest truth wins).

## Homebridge 2 update path

Never push live values with removed `Characteristic.getValue()`, and never call `updateValue(characteristic.value)` (that is the cached value). Store the getter next to the characteristic and call `updateValue(getFunc())` on Nest updates. See `src/utils/bound-characteristics.ts`.
