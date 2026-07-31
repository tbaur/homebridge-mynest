# Development

## Architecture

Two layers, meeting at the platform. Above it, accessories speak HomeKit. Below it, `api/` speaks Nest (REST + Observe) and knows nothing about HomeKit. The state layer between them is pure and fixture-testable.

| Area | Purpose |
| --- | --- |
| `src/platform.ts` | Discovery, accessory lifecycle, coalesced updates |
| `src/diagnostics/` | Opt-in health heartbeats and rollup (mirrors sibling plugins) |
| `src/api/session.ts` | Nest Account session (`GET /session`) |
| `src/api/rest.ts` | `app_launch` + `/v5/subscribe` |
| `src/api/observe.ts` | HTTP/2 Observe stream |
| `src/api/framing.ts` / `protobuf.ts` | Length-delimited frames and trait decode |
| `src/api/thermostat-write.ts` / `batch-update.ts` | Encode + POST Nest BatchUpdateState for thermostat control |
| `src/api/transport.ts` | Independent REST + Observe run loops (+ thermostat writes) |
| `src/state/*` | Observe∪REST merge, Protect/thermostat/sensor readers |
| `src/accessories/*` | HomeKit accessories + HB2-safe `CharacteristicBinder` |
| `src/utils/sanitizers.ts` | Central secret redaction |
| `assets/protobuf/` | Vendored Nest schemas (Observe decode + thermostat write encode) + ObserveTraits blob |

## Design principles

- **Nest Account tokens only.** Google JWT / `ya29.` shapes are rejected at config validation.
- **Observe ∪ REST.** Neither transport is a superset; thermostats are Observe-first; Observe-only Protects must appear.
- **Life-safety honesty.** No invented Protect all-clear or motion from unverified Observe fields.
- **HB2 update path.** Store getters; push with `updateValue(reader())` — never `getValue()`, never `updateValue(characteristic.value)`.
- **Dependency-light.** Runtime dependency is `protobufjs` only; `fetch` and `http2` are Node built-ins.
- **Secrets never reach the log.** Tokens, Basic headers, and user ids are redacted.

## Local workflow

```bash
npm install
npm test
npm run build
npm run lint
```

Live read-only check (requires `.env` with `NEST_ACCESS_TOKEN` — never commit it):

```bash
cp .env.example .env
npm run verify
```

`verify` drives compiled `dist/` against the live account and prints the merged inventory. It does not write setpoints. Treat its output as sensitive; prefer redacted paste into issues.

## Protocol notes

See [docs/PROTOCOL.md](docs/PROTOCOL.md) and [docs/AUTH.md](docs/AUTH.md). Arbitrary-looking constants in `src/settings.ts` are empirical; comments explain why they are what they are.

### Bumping the pinned Nest client identity

`USER_AGENT` (Chrome 77) and `WEB_APP_VERSION` are pinned because Nest's private backends check them. If production starts returning sustained HTTP 403s after a Nest edge change:

1. Capture a fresh session from the Nest web app and note the `User-Agent` / app version strings it sends.
2. Update the constants in `src/settings.ts` with a Conventional Commit explaining the Nest-side change.
3. Run `npm run verify` against a live account before merging.

Do not bump them casually — an incompatible schema version can change trait shapes this plugin cannot decode.

## Tests

Unit tests live under `tests/unit/` and use synthesized fixtures only — never live capture. Accessory tests run against real `hap-nodejs` services so the HB2 value-cache bug can actually reproduce.

Integration tests live under `tests/integration/` and exercise discovery / transport wiring against fixtures (no live Nest account):

```bash
npm run test:integration
```
