# Protocol notes

User-facing options and troubleshooting: [README-DETAILED.md](README-DETAILED.md). Sign-in setup: [AUTH.md](AUTH.md).

Nest publishes no consumer API. Everything below was confirmed with a probe kit against a live account. Treat this as a working map of private backends, not a promise Nest will keep them stable.

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
| REST `app_launch` empty or under half prior size | Treat as truncated; merge present keys; keep missing. Does not refresh the Protect alarm-feed clock |
| REST `app_launch` omits a key | Two consecutive complete omissions before drop |
| Observe reconnect empty or under half prior devices | Treat as incomplete; keep prior Observe state |
| Observe omits a `DEVICE_*` | Two consecutive complete snapshots before prune |
| Observe never connected this session | Do not unregister (REST-only view cannot prove thermostats are gone) |
| Cached accessory not named by Nest since the restart | Two settled Observe snapshots that both omit it before prune |
| Device absent from the Observe ∪ REST inventory after the above | Unregister from HomeKit |
| Rejected sign-in (Google refuses the cookies, Nest refuses a session opened less than a minute ago with HTTP 401, or HTTP 400 from `/session`), or a session this plugin cannot use | Stop updates; **keep** accessories. A session in use for longer that Nest refuses is renewed once instead. Any other failure, including HTTP 403 from either host, retries and does not stop the plugin, including when both transports exhaust their budget. Each transport probes again after the cooldown. Recovering needs new cookies and a restart, so unregistering would bounce rooms and automations in the meantime |

Unusable plugin config at startup (a missing or malformed Issue Token URL or Cookies, etc.) **keeps** the cached accessories, for the same reason a rejected sign-in does. A typo, a half-edited `config.json`, or a truncated cookie would otherwise destroy every room assignment, scene membership, and automation target in the Home app — and fixing the config does not bring them back, because HomeKit treats the re-registered accessories as new devices. A config error cannot warrant a more destructive response than a revoked sign-in. The plugin logs why and publishes nothing until it is restarted with a usable config.

A transient failure at startup (DNS, TLS, a timeout, a 5xx) is **not** fatal: it is retried with backoff, because `didFinishLaunching` fires only once and a host that boots before its network is up would otherwise stay idle for the lifetime of the process.

## Session

1. Config holds the Google `issueToken` URL and `Cookie` header from a sign-in at `home.nest.com`.
2. Plugin calls the issueToken URL (`https://accounts.google.com/o/oauth2/iframerpc?action=issueToken&...`) with those cookies, `X-Requested-With: XmlHttpRequest`, and `Sec-Fetch-Mode: cors`. Google answers with a Google OAuth `access_token` (`ya29.`, about one hour). A signed-out cookie gets HTTP 200 with an `error` field instead. Google also sends `Set-Cookie` updates for some cookies (`SIDCC` and similar) on every call; the plugin merges them and saves the result.
3. Plugin calls `POST https://nestauthproxyservice-pa.googleapis.com/v1/issue_jwt` with `Authorization: Bearer <Google token>` and body `{"embed_google_oauth_access_token": true, "expire_after": "3600s", "google_oauth_access_token": "<Google token>", "policy_id": "authproxy-oauth-policy"}`. Response yields `jwt` (a Nest token beginning `g.0.`) and `claims.expirationTime`.
4. Plugin calls `GET /session` with `Authorization: Basic <Nest token>`. Response yields session `access_token` (the same Nest token), `userid`, and `urls.transport_url`. Its `expires_in` is a date string unrelated to the Nest token's lifetime and is ignored.
5. REST calls use Basic auth with the session token; Observe uses the same token against `grpc-web.production.nest.com`.
6. Ten minutes before `claims.expirationTime`, the plugin repeats steps 2 to 4. A previous session stays valid until its own expiry, so streams move to the new session without a gap.

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

What Nest does publish is `auto_away` in REST `topaz`: roughly a ten-minute presence hold-off (`auto_away_decision_time_secs` is the window constant, not a timestamp). HomeKit occupancy is therefore:

- Published when REST `auto_away` is a boolean and the Protect is not reported as battery-powered. Power comes from REST `line_power_present` when it is a boolean. Otherwise it comes from the Observe `wall_power` trait: a reported trait without `present: true` means battery-powered, because proto3 omits a false field. Unknown power (neither source) does not hide a boolean Nest already sent.
- Unavailable for battery Protects, when `auto_away` is missing, and for Observe-only Protects until REST sends the boolean.
- Documented as presence, not pathlight-speed motion.

## Protect smoke / CO

Alarm status is taken from REST `topaz` (`smoke_status` / `co_status`), and only while the REST feed can refresh it. Observe streams `safety_alarm_*` traits, but no public schema maps them and captured samples have all been all-clear. Inferring "no smoke" from an unverified enum is refused.

Every Protect gets smoke and CO HomeKit services. A missing `smoke_status` or `co_status` leaves that sensor inactive and faulted and does not write a clear. REST counts as unavailable when any of these is true: the subscribe circuit breaker is not closed (open or half-open), the HTTP 403 budget is exhausted, the REST loop has exited, no subscribe return or complete `app_launch` arrived in the last 3 minutes, or Nest has not actually answered (a complete `app_launch` or a subscribe that got an HTTP response) in the last 8 minutes. A subscribe that the client timed out still counts toward the 3-minute clock but not the 8-minute one. On a quiet house the plugin runs an `app_launch` after 5 minutes without an answer, so a healthy account never reaches the 8-minute limit. When REST is unavailable, smoke and CO services stay published with last-known values but `StatusActive=false` and `StatusFault=GENERAL_FAULT`. An incomplete `app_launch` moves neither clock, and an empty one counts as incomplete. `app_launch` has its own circuit breaker, so an outage on its host does not stop the subscribe that carries alarms. Leaving a frozen clear that still looks live would be dishonest, and tearing services down would break HomeKit rooms and automations on every Nest blip. Battery-low status can still come from Observe. The smoke and CO tiles stay inactive while that sensor has no REST number or the REST feed is stale, including when Observe says the Protect is online. HTTP 403 does not mean the sign-in is revoked. The plugin keeps probing.

## Thermostat writes

HVAC state updates arrive over Observe (`target_temperature_settings` / `hvac_control` / `eco_mode_state`). Writes use the same protobuf gateway as the Nest web app:

### Mode / setpoints

1. Encode `nest.trait.hvac.TargetTemperatureSettingsTrait` (mode via `settings.hvacMode` + `active`; setpoints as `targetTemperatureHeat` / `targetTemperatureCool`).
2. Wrap in `nest.rpc.NestMessage` `{ set: [{ object: { id: DEVICE_…, key: target_temperature_settings, uuid }, property: Any }] }`.
3. `POST https://grpc-web.production.nest.com/nestlabs.gateway.v1.TraitBatchApi/BatchUpdateState` with `Content-Type: application/x-protobuf` and the session Basic token.

`off` is `active=0` with a standby `HEAT`/`COOL` left in `hvacMode` — Nest does not store an OFF enum there. REST `/v5/put` cannot reach Observe-only thermostats.

Plugin flag: `allowThermostatControl` (default **off**). Manual HomeKit setpoint/mode writes clear Nest Eco (`eco_mode_state` OFF) in the same batch when Eco was active.

HomeKit sends a scene's mode and setpoints as separate writes in the same request. The plugin merges the changes that arrive together into one Nest write. A later change builds on the last sent write until Nest reports the sent mode and setpoints, or 60s pass, so it does not resend Nest's older values.

> The encode shape was confirmed against a live account with a maintainer-only probe kit (`nest-probe`), which is **not part of this repository** and is not something a user or contributor can run. Treat references to it as provenance for where these findings came from, not as a step to reproduce.

### Eco Mode (on / off)

HomeKit has no Eco thermostat mode, so the plugin exposes Eco as a Switch (per thermostat, plus optional house-wide `exposeGlobalEcoSwitch`). Writes are a separate BatchUpdateState body:

1. Encode `nest.trait.hvac.EcoModeStateTrait` with `ecoEnabled` `ON` or `OFF` and `ecoModeChangeReason` `ECO_MODE_CHANGE_REASON_MANUAL`.
2. Wrap in `nest.rpc.NestMessage` `{ set: [{ object: { id: DEVICE_…, key: eco_mode_state, uuid }, property: Any }] }` (`encodeEcoModeBatchUpdate`).
3. Same `TraitBatchApi/BatchUpdateState` endpoint and auth as setpoint writes.

Eco-only writes were never confirmed against a live account the way setpoints were; enable `allowThermostatControl` only if you are comfortable with live Nest writes on your account.

The optional house-wide switch (`exposeGlobalEcoSwitch`) posts Eco to every live thermostat accessory. It reports success only when every write succeeds. A partial failure is a HomeKit error. HomeKit stays optimistic until Nest's all-Eco aggregate matches, or 45s elapses and the latest Nest aggregate wins. If Nest has not reported an aggregate by then, the switch keeps the written value. Nest has an aggregate only after the Observe snapshot settles and every Observe thermostat has reported Eco. REST-only thermostats are left out of it. Until then the switch keeps its cached value.

## Homebridge 2 update path

Never push live values with removed `Characteristic.getValue()`, and never call `updateValue(characteristic.value)` (that is the cached value). Store the getter next to the characteristic and call `updateValue(getFunc())` on Nest updates. See `src/utils/bound-characteristics.ts`.
