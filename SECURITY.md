# Security Policy

## Supported Versions

Only the latest published release is supported. Fixes are shipped forward rather than backported, so the answer to "is my version supported?" is always "upgrade to the newest release".

| Version | Supported |
| ------- | ----------------- |
| Latest release | ✅ Active support |
| Anything older | ❌ Unsupported — upgrade |

The next release requires **Homebridge 2.x and Node.js 22 or newer**; Homebridge 1.x is no longer supported.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public issue**
2. Email the maintainer directly or use GitHub's [private vulnerability reporting](https://github.com/tbaur/homebridge-mynest/security/advisories/new)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Any suggested fixes

## The Nest Account access token

How to capture the token is in [docs/AUTH.md](docs/AUTH.md). This section is the threat model.

Nest publishes no consumer API. This plugin authenticates with a Nest Account `access_token` copied from `https://home.nest.com/session`. Understand what that token is before you configure the plugin:

- **It is account-scoped Nest credentials**, not a HomeKit pairing code. Anyone who has it can act as the Nest web app for that account.
- **It is stored in plaintext.** Homebridge keeps plugin configuration in `config.json` on disk, unencrypted. Anyone who can read that file — or a backup of it — holds a durable credential to the Nest home.
- **Google cookies and OAuth tokens are rejected on purpose.** They cover a broader Google identity than Nest Account access and are a different auth surface this plugin does not implement.

Treat the token as a password-equivalent credential. Do not paste it into issues, logs, screenshots, or chat.

**Revoking it.** Sign out Nest sessions / rotate Nest account credentials from Nest's account settings, then capture a fresh token and update Homebridge.

## Security Measures

This plugin implements:

- Nest Account tokens only — Google JWT / `ya29.` shapes are rejected at config validation
- Secret redaction in structured logs
- Transport URL host allowlisting before the session token is sent
- Thermostat mode/setpoint/Eco writes use Nest BatchUpdateState behind opt-in `allowThermostatControl` (off by default)
- No analytics or telemetry

## Scope limits

Out-of-scope devices are listed in the [README](README.md#supported-devices): cameras, doorbells, Yale locks, Home/Away structure switches, and Google-account-only homes.

Life-safety alarm state for Protects is only published while Nest REST can refresh it; Observe-only units and Protects whose REST feed is down do not keep a frozen all-clear.
