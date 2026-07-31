# Scripts

| Script | Purpose |
| --- | --- |
| `verify.mjs` | Live read-only check of compiled `dist/` against a Nest Account |

```bash
cp .env.example .env
# set NEST_ACCESS_TOKEN
npm run build
npm run verify
```

Never commit `.env` or paste tokens into issues. `verify` does not write thermostat setpoints or modes.
