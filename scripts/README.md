# Scripts

| Script | Purpose |
| --- | --- |
| `verify.mjs` | Live read-only check of compiled `dist/` against a Nest Account |

```bash
cp .env.example .env
# set NEST_ACCESS_TOKEN
npm run verify
```

`npm run verify` builds first, so no separate `npm run build` is needed. Pass `--listen <seconds>` to hold the Observe stream open longer, or `--verbose` for per-trait detail.

Never commit `.env` or paste tokens into issues. `verify` does not write thermostat setpoints or modes.
