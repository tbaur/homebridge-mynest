# Authentication

Install and options: [README](../README.md). Full options and troubleshooting: [README-DETAILED.md](README-DETAILED.md).

The plugin signs in with a Google account. You copy two values from a browser once: the **Issue Token URL** and the **Cookies**. From then on the plugin signs itself in and renews its Nest session about every hour, with nothing to paste again.

Nest publishes no consumer API for thermostats and Protects, so the plugin signs in the same way the Nest web app does:

1. It sends the Cookies to Google's issueToken endpoint and receives a short-lived Google OAuth token.
2. It exchanges that token with Nest's auth proxy for a Nest token that lasts one hour.
3. It opens a Nest session with that token and uses it for REST, Observe, and thermostat writes.
4. About ten minutes before the Nest token expires, it repeats steps 1 to 3. The old session keeps working until the new one is ready, so updates do not pause.

The wire details are in [PROTOCOL.md](PROTOCOL.md).

## Use a dedicated Google account

The Cookies sign in to the **whole Google account**, not only to Nest. Anyone who can read them can use that account's Gmail, Drive, and everything else. Do not use your personal account.

1. Create a new Google account used only for Homebridge.
2. In the Google Home app, invite that account to your home.
3. Make the account an **admin** of the home. A member who is not an admin does not see the home's Nest devices.
4. Sign in to [home.nest.com](https://home.nest.com) once as that account and confirm your thermostats and Protects are listed.

If the Cookies ever leak, an attacker gets a throwaway account that can manage your home and nothing else. Remove it from the home to cut it off.

## Copy the two values

Use a private browsing window, so the sign-in is separate from your own Google session. Each value is long; copy it whole.

### Safari

1. Turn on **Safari → Settings → Advanced → Show features for web developers**.
2. Open **File → New Private Window**, then **Develop → Show Web Inspector** and the **Network** tab. Turn on **Preserve Log**.
3. Go to [home.nest.com](https://home.nest.com) and sign in with Google as the dedicated account.
4. Type `issueToken` in the Network filter. Select the request and copy its full URL from **Headers → Summary**. That is the **Issue Token URL**.
5. Type `iframe` in the filter. Select the `accounts.google.com/o/oauth2/iframe` request and copy the value of `Cookie` under **Request Headers**. That is the **Cookies** value.
6. Close the window **without signing out**. Signing out ends the session the Cookies belong to.

If no `issueToken` request appears, or the `iframe` request has no `Cookie` header, turn off **Settings → Privacy → Prevent cross-site tracking** for the capture, then turn it back on.

### Chrome, Edge, or Firefox

1. Open a private or incognito window, then the developer tools (`F12`) and the **Network** tab. Turn on **Preserve log**.
2. Go to [home.nest.com](https://home.nest.com) and sign in with Google as the dedicated account.
3. Filter for `issueToken`. Copy the request URL. That is the **Issue Token URL**.
4. Filter for `iframe`. On the `accounts.google.com/o/oauth2/iframe` request, copy the `cookie` request header value. That is the **Cookies** value.
5. Close the window **without signing out**.

## Configure the plugin

Paste both values into the plugin settings in the Homebridge UI, or into `config.json`:

```json
{
  "platform": "MyNest",
  "name": "MyNest",
  "issueToken": "https://accounts.google.com/o/oauth2/iframerpc?action=issueToken&...",
  "cookies": "SID=...; HSID=...; ..."
}
```

The plugin checks both values at startup. The Issue Token URL must be Google's `https://accounts.google.com/o/oauth2/iframerpc` endpoint with `action=issueToken`, because the plugin sends the Cookies to it and nowhere else. The Cookies must include Google's `SID` cookie. A leading `Cookie:` copied with the value is removed.

## What the plugin stores

- **`config.json`** holds the two values in plaintext, like every Homebridge secret.
- **`<Homebridge storage>/homebridge-mynest/google-cookies.json`** holds the cookies Google updates during sign-in. A browser stores these updates too; the plugin keeps them so a restart signs in with what Google last issued. The file is readable only by the Homebridge user. It is tied to the Cookies in the config, so pasting new Cookies replaces it.

Tokens, cookies, the Issue Token URL, and the account's email address are redacted from logs and diagnostics.

## When sign-in stops working

The Cookies keep working until the account signs out or Google ends the session, for example after a password change or a security check. When that happens the plugin logs:

> Google sign-in was rejected. Copy a new Issue Token URL and Cookies as described in docs/AUTH.md, then restart Homebridge.

It then stops updating and keeps every accessory in HomeKit, so rooms and automations survive. Copy both values again, update the config, and restart Homebridge.

A network outage or a Google or Nest error does not stop the plugin. It retries with backoff on its own.

## Revoking access

To cut the plugin off, do any of these as the dedicated account or as the home's owner:

- Remove the dedicated account from the home in the Google Home app.
- Change the dedicated account's password, which ends its sessions.
- Sign out of all sessions from the dedicated account's [Google Account security page](https://myaccount.google.com/security).

The threat model is in [SECURITY.md](../SECURITY.md).
