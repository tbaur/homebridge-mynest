# Contributing

Thanks for interest in improving `homebridge-mynest`.

## Development setup

```bash
npm install
npm test
npm run build
npm run lint
npm run typecheck
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture and [RELEASING.md](RELEASING.md) for the release-please / npm Trusted Publishing flow.

Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, …).

## Rules of the road

- **Do not copy** code from `chrisjshull/homebridge-nest` or other Nest plugins. Reimplement from probes and Nest behaviour.
- **No Google auth.** Nest Account `access_token` only.
- **No secrets in the repo.** Use `.env` (gitignored) for live scripts; never commit tokens or probe captures that contain account data.
- **Life-safety honesty.** Do not invent Protect all-clear or motion from unverified Observe fields.
- **Homebridge 2 update path.** Use `CharacteristicBinder` / `updateValue(reader())` — never `getValue()` for pushes, never `updateValue(characteristic.value)`.

## Live verification

```bash
cp .env.example .env
# paste NEST_ACCESS_TOKEN
npm run verify
```

`verify` is read-only. Thermostat setpoint and Eco writes go through Nest BatchUpdateState (`encodeTargetTemperatureBatchUpdate` / `encodeEcoModeBatchUpdate`). Their encode shapes were established with a maintainer-only probe kit that is not part of this repository, so a change to either needs a live account to validate against — say so in the PR rather than relying on the unit tests alone.

## Pull requests

- Keep PRs focused
- Include tests for behaviour changes
- Update docs when user-facing semantics change (especially occupancy and smoke/CO)
