# Authentication

This plugin supports **Nest Account** access tokens only. Google account sign-in (browser cookies, `issueToken`, `ya29.` OAuth tokens, JWTs) is intentionally not implemented.

Nest publishes no consumer API for this path. The plugin opens a session the same way the Nest web app does: `GET https://home.nest.com/session` with `Authorization: Basic <access_token>`, then uses the session `access_token`, `userid`, and `urls.transport_url` for REST and Observe.

## Getting the token

1. Sign in at [home.nest.com](https://home.nest.com) with a Nest Account (the pre-Google Nest login lineage).
2. In the same browser, open [https://home.nest.com/session](https://home.nest.com/session).
3. Copy the `access_token` field from the JSON response.
4. Paste it into the plugin's **Nest access token** field (or into `NEST_ACCESS_TOKEN` for `npm run verify`).

You want the Nest Account token from that session JSON — not a Google cookie, not a JWT (`eyJ…`), and not a `ya29.` OAuth token.

## Treat it as a password

Anyone with this token can control every thermostat and smoke alarm on the Nest Account. Homebridge stores it in plaintext in `config.json`.

- Do not paste it into issues, logs, screenshots, or chat.
- Prefer a Nest Account used only for Homebridge when that is practical.
- If it leaks, revoke Nest sessions / rotate credentials from Nest's account settings, then capture a fresh token.

When Nest rejects the token you will see an authentication error in the Homebridge log and the plugin will stop retrying until you fix the config and restart.

The wire protocol around the session is in [PROTOCOL.md](PROTOCOL.md). The threat model is in [SECURITY.md](../SECURITY.md).
