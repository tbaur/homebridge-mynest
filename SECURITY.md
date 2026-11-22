# Security Policy

## Supported Versions

Only the latest published release is supported. Fixes are shipped forward rather than backported, so the answer to "is my version supported?" is always "upgrade to the newest release".

| Version | Supported |
| ------- | ----------------- |
| Latest release | ✅ Active support |
| Anything older | ❌ Unsupported — upgrade |

Requires **Homebridge 2.x** and **Node.js 22, 24, or 26**.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public issue**
2. Use GitHub's [private vulnerability reporting](https://github.com/tbaur/homebridge-mynest/security/advisories/new)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Any suggested fixes

## The Google sign-in cookies

How to copy the sign-in values is in [docs/AUTH.md](docs/AUTH.md). This section is the threat model.

Nest publishes no consumer API. This plugin signs in the way the Nest web app does: it sends the configured Google cookies to Google's issueToken endpoint, exchanges the resulting OAuth token for an hour-long Nest token, and renews it before it expires. Understand what the cookies are before you configure the plugin:

- **They sign in to the whole Google account**, not only to Nest. Anyone who has them can use that account's other Google services. Use a dedicated Google account that is an admin of the home and is used for nothing else.
- **They are stored in plaintext.** Homebridge keeps plugin configuration in `config.json` on disk, unencrypted. The cookies Google updates during sign-in are kept in `homebridge-mynest/google-cookies.json` under the Homebridge storage path, readable only by the Homebridge user. Anyone who can read either file, or a backup of it, holds a working sign-in to that account.
- **They are sent only to Google.** The Issue Token URL must be `https://accounts.google.com/o/oauth2/iframerpc`; any other host, port, or path is refused at startup.

Treat the cookies as a password-equivalent credential. Do not paste them into issues, logs, screenshots, or chat.

**Revoking them.** Remove the dedicated account from the home in the Google Home app, or change its password, or sign it out of all sessions from its Google Account security page. Then copy new values if you want the plugin to keep working.

## Security Measures

This plugin implements:

- The Issue Token URL is restricted to Google's issueToken endpoint, so the cookies cannot be sent elsewhere
- Redaction of cookies, Google and Nest tokens, and the account email in logs and diagnostics
- Transport URL host allowlisting before the session token is sent
- Saved cookies are written owner-only (`0600`) and are discarded when the configured cookies change
- Thermostat mode/setpoint/Eco writes use Nest BatchUpdateState behind opt-in `allowThermostatControl` (off by default)
- No analytics or telemetry

## Scope limits

Out-of-scope devices are listed in the [README](README.md#supported-devices): cameras, doorbells, Yale locks, and Home/Away structure switches.

Life-safety alarm state for Protects is only treated as live while Nest REST can refresh it. A missing number or a stale REST feed leaves the smoke and CO sensors published, inactive, and faulted, so HomeKit does not keep a frozen all-clear. An `app_launch` that is empty or under half the previous object count still merges the objects it contains, and it does not refresh that clock.
