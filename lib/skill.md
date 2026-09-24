# Browser control over CDP

Drive a Chromium-family browser already running on this machine. The plugin
attaches to whichever one has remote debugging enabled; it never launches one.

## Calling convention

Send one command per call over the loopback route, with the shell tool you
already have; there are no browser-specific tools.

```powershell
# success: {ok:true, ...result}   failure: {ok:false, error, message}
$r = Invoke-RestMethod -Uri "$env:DSH_WEB_URL{{routePath}}?cmd=tabs" -Method Post `
  -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck
$r | ConvertTo-Json -Depth 6
```

Connecting is lazy: the first command that needs the browser attaches, so
`status` reporting `idle` is normal and means no prompt has been raised yet. An
approval refusal arrives as **HTTP 409** carrying `error: "awaiting-approval"` —
a body you only get with `-SkipHttpErrorCheck`, otherwise it surfaces as a
PowerShell exception. Tell the user to click **Allow**, then retry once; never
retry in a loop.

## Commands

| cmd | body fields | returns |
|---|---|---|
| `status` | — | connection/authorization state, browser, endpoint, uptime; never attaches |
| `browsers` | — | installed Chromium browsers and whether each CDP endpoint is live; never attaches |
| `connect` | — | attach explicitly |
| `tabs` | — | open pages: `id`, `title`, `url` |
| `open` | `url` | new tab: `id` (this is the `tabId`), `url` |
| `goto` | `url`, `tabId?` | navigated tab |
| `close` | `tabId?` | closed tab |
| `eval` | `expression`, `tabId?` | expression value |
| `snapshot` | `tabId?`, `limit?` | trimmed DOM tree (node cap applies) |
| `click` | `selector` or `x`+`y`, `tabId?` | what was clicked |
| `type` | `text`, `selector?`, `tabId?` | characters typed |
| `shot` | `tabId?`, `fullPage?`, `out?` (directory) | **path** to a PNG on disk |
| `assert` | `checks[]`, `tabId?` | pass/fail report |
| `reconnect` / `stop` | — | connection control |

`open`/`goto` also take `settleMs`, `eval` takes `awaitPromise`; `console` and
`network` are accepted but capture nothing.

## Tabs you did not open are read-only

The browser holds the user's own session, so the tabs already open may be in
active use. This is a rule you keep, not one the plugin enforces: always pass an
explicit `tabId`, because omitting it falls back to the first page the browser
reports — normally one of the user's.

- **Reading is fine:** `tabs`, `snapshot`, `shot`, and an `eval` that only
  inspects. This is how you find out what is on the page.
- **Changing a page needs a tab you opened:** `goto`, `click`, `type`, any
  `assert` check carrying `click`, and `close` must target an id returned by
  your own `open`. Navigating, typing in, or closing a tab the user is looking
  at moves the page out from under them.
- **To act on a page that is already open, `open` your own tab and `goto` the
  same URL** — the copy is authenticated too, since the login state is the
  browser's. Read the `url` from `tabs` rather than driving the original.
- **Close what you opened, in the turn that opened it.** Keep the id for every
  follow-up call on that page and `close` it once the work is done; a tab left
  behind is a visible change to the user's browser.

## Keeping token use low

- **Screenshots return a path, never image data.** Inspect it with the image
  reader; never ask for base64.
- Prefer `assert` over screenshots you describe yourself — one call answers
  several questions deterministically and may carry several checks.
- `snapshot` is capped and ordered outermost-first. Start with a small `limit`
  and raise it only if the tree is genuinely needed.
- In `eval`, return exactly the fields you need (`({t: document.title})`), not
  whole elements or `outerHTML`.

## Assertion checks

```json
{"checks": [
  {"name": "header", "type": "css", "selector": "h1", "property": "color", "equals": "rgb(0, 0, 0)"},
  {"name": "present", "type": "dom", "selector": "#app", "text": "Ready"},
  {"name": "no-error", "type": "dom", "selector": ".error", "absent": true},
  {"name": "pixel", "type": "pixel", "x": 0.5, "y": 0.1, "color": "#ffffff", "tolerance": 12}
]}
```

`type` defaults to `js` (`expression`, truthy unless `equals` is given); `css`
also accepts `matches` and `contains`. Every check accepts `click` (`"selector"`
or `{x,y}`) and `waitMs` to act before asserting, with coordinates in `0..1`
relative to the viewport. Read `passed`/`failed` — the envelope's `ok: true`
only means the command ran.

## Notes

- The plugin never launches a browser. If nothing is found, run `browsers` and
  give the user the printed launch command. A browser started with an explicit
  non-zero `--remote-debugging-port` is found on that port; otherwise discovery
  reads the profile's `DevToolsActivePort` file.
- On Chrome/Edge 136+ the default profile refuses an explicit debug port; the
  supported route there is the browser's own remote-debugging approval flow.
