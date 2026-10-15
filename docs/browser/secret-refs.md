# Secret Refs: filling stored test credentials

> **Bind only test-account credentials.** After a fill, the script can read
> the field and send the value anywhere. The `origins` list controls only
> where the plugin types it. See [Limits](#limits).

Agent scripts can type a stored test credential into a page without the value
ever entering the script. Two helpers exist inside `browser_script` /
`bb plugin run browser script`:

```js
await fillSecret("#password", "app-console-password");
await fillTotp("#otp", "app-console-totp");
```

`fillSecret` types the stored value. `fillTotp` types the current one-time code
computed from a stored authenticator seed. Both act on the script's bound
`page`, in its top-level document.

## The binding file

Only refs listed in `/root/.bb-server/secrets/browser-secret-refs.json` exist.
The file must be owned by the host user (root) with mode `0600`; otherwise every
fill is refused. A missing file means no refs exist. An empty example ships at
[`browser-secret-refs.example.json`](browser-secret-refs.example.json).

```json
{
  "refs": {
    "app-console-password": {
      "file": "app.env",
      "var": "CONSOLE_OWNER_PASSWORD",
      "origins": ["https://console.example.com"]
    },
    "app-console-totp": {
      "file": "app.env",
      "var": "CONSOLE_OWNER_TOTP_SECRET",
      "origins": ["https://console.example.com"],
      "totp": true
    }
  }
}
```

- `file`: an env file inside `/root/.bb-server/secrets/` (a bare name or an
  absolute path inside that folder). At fill time the file must be a regular
  file reached without any symlink, with its real path inside that folder, a
  single name (no second hard link), owned by root, and mode `0600`. Otherwise
  the fill is refused.
- `var`: the variable in that file.
- `origins`: the exact `https://` origins where the value may be typed. Plain
  `http://` is accepted only for a local dev server on a loopback host
  (`localhost`, `127.0.0.1`, `[::1]`), for example `http://localhost:5001`. It
  matches only that exact origin: another port or another host spelling is
  refused. Any process that serves that port receives the value.
- `totp`: marks the variable as an authenticator seed (base32). `true` means
  RFC 6238 SHA-1, 30-second period, 6 digits. Override with
  `{ "algorithm": "SHA256", "period": 60, "digits": 8 }`.

Being a seed belongs to the variable, not the ref. If any ref marks a `file`
and `var` pair as `totp`, every ref to that pair must be `totp`; otherwise the
whole binding file is rejected. A variable whose name contains `TOTP_SECRET`
must also be marked `totp`. So `fillSecret` never types a variable that any
ref marks as a seed, and `fillTotp` refuses a plain ref.

## What the host checks

For each call the host, not the script:

1. Looks up the ref. Unknown refs are refused.
2. Finds the element in a top-level page of this session.
3. Checks that page's current origin against `origins`. A redirect after
   navigation is caught here.
4. Checks that the element is an `<input>`.
5. Reads the variable. A missing file or variable is refused.
6. Types the value through its own browser connection.

A refusal names the ref (and the page origin when it does not match), never the
value. The script receives only success or the refusal.

## Redaction

Every value resolved during a run, including each typed one-time code and the
seed it came from, is replaced with `[redacted]` in that run's output and
errors. Activity Records hold metadata only.

## Limits

- **After a fill, the script can read the value and send it anywhere.** It can
  read the field with `page.inputValue` or `evaluate`, encode it, and send it
  to another origin with `fetch` or a navigation. Redaction removes only the
  plain value from that run's output and errors; encoded copies pass through,
  and a later run sees no redaction at all. The `origins` list controls only
  where the plugin types the value, not where it goes afterwards.
- The real controls are:
  1. Bind only test-account credentials, never a personal or production one.
  2. Only agents with browser access can run scripts, so only they can call
     `fillSecret` or `fillTotp`.
- A script can fill the same ref again in the same run, as often as it likes.
  This is by design: a login form may need a retry.
- A screenshot shows whatever the page renders. Password inputs render dots;
  a plain text input shows the value. Screenshots are not redacted.
- A plain-http loopback origin gives no transport protection: any process
  serving that port receives the value.
- Elements inside iframes cannot be filled.
