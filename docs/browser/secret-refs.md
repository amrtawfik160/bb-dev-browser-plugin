# Secret Refs: filling stored test credentials

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
  absolute path inside that folder).
- `var`: the variable in that file.
- `origins`: the exact `https://` origins where the value may be typed.
- `totp`: marks the variable as an authenticator seed (base32). `true` means
  RFC 6238 SHA-1, 30-second period, 6 digits. Override with
  `{ "algorithm": "SHA256", "period": 60, "digits": 8 }`.

A variable whose name contains `TOTP_SECRET` must be marked `totp`; the file is
rejected otherwise. A seed is never typed as itself: `fillSecret` refuses a
`totp` ref and `fillTotp` refuses a plain one.

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

- A script can still read the input's DOM value after the fill, for example
  with `page.inputValue`. Redaction removes it from that run's output and
  errors, but the script could encode it first. The origin binding is what
  limits where a value can go: only pages on a listed origin receive it.
- A screenshot shows whatever the page renders. Password inputs render dots;
  a plain text input shows the value.
- Elements inside iframes cannot be filled.
