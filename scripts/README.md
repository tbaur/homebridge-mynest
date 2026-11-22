# Scripts

User-facing options: [docs/README-DETAILED.md](../docs/README-DETAILED.md). Sign-in values: [docs/AUTH.md](../docs/AUTH.md).

| Script | Purpose |
| --- | --- |
| `verify.mjs` | Live read-only check of compiled `dist/` against a Google account |

```bash
cp .env.example .env
# set NEST_ISSUE_TOKEN and NEST_COOKIES, each on one line
npm run verify
```

`npm run verify` builds first, so no separate `npm run build` is needed. Pass `--listen <seconds>` to hold the Observe stream open longer, or `--verbose` for per-trait detail.

Never commit `.env` or paste the sign-in values into issues. `verify` does not write thermostat setpoints or modes.
