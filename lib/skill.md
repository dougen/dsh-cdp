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
| `tabs` | — | open pages: `id`, `title`, `url`, `owned` |
| `open` | `url` | new tab: `id` (this is the `tabId`), `url` |
| `goto` | `url`, `tabId?` | navigated tab |
| `back` / `forward` | `tabId?` | navigated tab (history entry) |
| `close` | `tabId?` | closed tab |
| `activate` | `tabId?` | raised tab — needed before shooting a background tab |
| `eval` | `expression`, `tabId?`, `awaitPromise?` | expression value; `kind` says whether it was a plain value, an unserializable one (`NaN`, `Infinity`), or an object |
| `snapshot` | `tabId?`, `limit?`, `aria?`, `boxes?` | DOM outline, or with `aria:true` an accessibility tree with `[ref=eN]` handles |
| `click` | `selector` / `ref` / `x`+`y` (exactly one), `tabId?`, `doubleClick?`, `button?`, `modifiers?` | what was clicked |
| `hover` | `selector` / `ref` / `x`+`y` (exactly one), `tabId?` | what was hovered |
| `drag` | `fromSelector`/`fromRef`/`fromX`+`fromY`, `toSelector`/`toRef`/`toX`+`toY`, `steps?`, `tabId?` | the two endpoints |
| `wheel` | `deltaX`, `deltaY`, `x?`, `y?`, `tabId?` | where it scrolled and by which path (`via`) |
| `type` | `text`, `selector?`/`ref?`, `submit?`, `pressAfter?`, `delayMs?`, `tabId?` | characters typed |
| `key` | `key` (e.g. `Enter`, `Escape`, `Tab`, `Ctrl+A`), `selector?`/`ref?`, `tabId?` | key pressed |
| `select` | `selector`, `value`/`values`, `byLabel?`, `tabId?` | the value actually set |
| `upload` | `selector`, `files[]` (absolute paths inside the host's allowed roots), `tabId?` | files attached by path |
| `wait` | `text`/`textGone`/`selector`(+`gone`)/`expression`, `timeoutMs?`, `tabId?` | `ok` and how long it waited |
| `resize` | `width`, `height` (numbers), `mobile?`, `deviceScaleFactor?`, or `clear:true` | the emulated viewport |
| `media` | `colorScheme?`, `reducedMotion?`, `forcedColors?`, `contrast?`, `media?` | the emulated media state |
| `shot` | `tabId?`, `fullPage?`, `out?` (relative directory under the host's screenshot dir) | **path** to a PNG on disk; `truncated` is true if the page was larger than the full-page cap |
| `console` | `tabId?`, `level?`, `limit?` | captured console/log lines **and** any dialogs the page raised; `trimmed` says the output was cut to fit the response budget |
| `dialog` | `tabId?`, `accept?` / `dismiss?`, `promptText?` | what is blocking the tab, or the result of answering it |
| `network` | `tabId?`, `index?`, `filter?`, `limit?` | numbered request list, or one request in full with its body; `trimmed` says the list was cut to fit |
| `assert` | `checks[]` (at most 50), `tabId?` | pass/fail report |
| `reconnect` / `stop` | — | connection control |

`open`/`goto` also take `settleMs`.

`status` and `browsers` answer without waiting for the running command, so
polling them never blocks behind a long `wait`.

## Prefer `wait` over fixed delays

`wait` polls in the page and returns as soon as the condition holds, so it is
both faster and steadier than a guessed `settleMs`:

```json
{"selector": "#results tbody tr"}          // appears
{"text": "Saved"}                           // text shows up
{"textGone": "Loading…"}                    // spinner gone
{"selector": ".spinner", "gone": true}      // same, by selector
{"expression": "document.readyState === 'complete'"}
```

A timeout returns `ok:false` rather than an error — a slow page is a fact to
report, not a command failure. Do not follow a timeout with a blind retry loop;
read the page and decide.

## Refs: aim at what the page means, not at a CSS path

`snapshot` with `"aria": true` returns the accessibility tree, where each
actionable node carries a `[ref=eN]` handle:

```
- navigation [ref=e2]
  - link "Home" [ref=e3]
- button "Save" [ref=e5]
- textbox "Search" [ref=e7]
```

Pass `ref` wherever `selector` is accepted (`click`, `hover`, `type`, `key`,
`drag`). A ref survives markup churn that would break a CSS path — an extra
wrapper `div` changes every selector but not the role/name pair.

Ref numbers are never reused: each snapshot continues the numbering rather than
restarting it, so a ref from an older snapshot is reported as unknown instead of
quietly pointing at whatever now occupies that position. Take a fresh snapshot
after the page changes.

## Uploading files

`upload` attaches files to a file input by absolute path. The paths must be
inside the directories the host configured (`uploadRoots`); anything else is
refused, and with no roots configured the command is off. The plugin runs
outside the agent's file sandbox, so the boundary is set by the host rather
than per request.

```json
{"selector": "#avatar", "files": ["C:\\Users\\me\\pictures\\a.png"]}
```

The file must exist and be a regular file; the error names the path that could
not be read.


## Writing requires a tab you opened

The browser holds the user's own session, so pages already open may be in
active use. This is enforced, not advisory: `goto`, `back`/`forward`, `click`,
`hover`, `wheel`, `type`, `key`, `select`, `upload`, `drag`, `resize`, `media`,
`close`, and any `assert` whose checks carry `click` must pass the `tabId` of a
tab you opened with `open`. Omitting `tabId` on those commands is an error, not
a fallback to the first page.

`activate`, `tabs`, `snapshot`, `shot`, `console`, `network`, and an inspecting
`eval` work on any tab.

- **Reading is fine anywhere:** `tabs` (its `owned` flag tells you which are
  yours), `snapshot`, `shot`, `console`, `network`, and an `eval` that only
  inspects. This is how you find out what is on a page.
- **Anything that changes what the user sees is a write**, including `hover`
  (it opens menus), `wheel` (it moves the page and can trigger lazy loading),
  and `resize`/`media` (they change the layout and the colour scheme). They
  need a tab you opened, like `click` does.
- **To act on a page that is already open, `open` your own tab and `goto` the
  same URL** — the copy is authenticated too, since the login state is the
  browser's. Read the `url` from `tabs` rather than driving the original.
- **Close what you opened, in the turn that opened it.** Keep the id for every
  follow-up call on that page and `close` it once the work is done; a tab left
  behind is a visible change to the user's browser.
- After a reconnect your earlier tabs are no longer owned — `open` a fresh one.
- `eval` has no read/write distinction, so the guard does not apply to it.
  Keep `eval` side-effect free on tabs you did not open.

## Dialogs

A JavaScript `alert`/`confirm`/`prompt` blocks the tab: while one is open, no
protocol call to that page can complete. On a tab you opened the plugin answers
dialogs for you (`dismiss` by default, so the page continues down its cancel
path) and records them; `console` lists them under `dialogs`.

On a tab you did **not** open, dialogs are recorded but never answered — that is
the user's page and clicking OK on their behalf is a write to their session.
Tell the user what the page is asking and let them answer it in the browser; an
answer sent through `dialog` for a tab you did not open is refused.

```json
{"tabId": "…", "accept": true}          // press OK on a tab you opened
{"tabId": "…", "dismiss": true}         // press Cancel
{"tabId": "…", "accept": true, "promptText": "typed answer"}
```

Without `accept`/`dismiss`, `dialog` reports what is currently blocking the tab
(`pending`), on any tab.

## Emulated viewport and media

`resize` and `media` are per-session overrides, so they disappear when the
session ends and never change what the user sees in their own window. Use them
to check the two things that are invisible at the current size:

```json
{"width": 375, "height": 700}       // a phone breakpoint
{"clear": true}                     // back to the real viewport
{"colorScheme": "dark"}             // prefers-color-scheme: dark
{"media": "print"}                  // the print stylesheet
```

`width` and `height` must be numbers — a string or a boolean is refused rather
than coerced. The media values come from the CSS vocabulary (`light`/`dark`,
`no-preference`/`reduce`, `none`/`active`, `screen`/`print`); anything else is
rejected, because the browser accepts a wrong value silently and simply never
matches it.

## Logins, CAPTCHAs, and other human-only steps

There is no bypass and you must not improvise one. When a page you are driving
hits a login wall, a CAPTCHA, a 2FA prompt, or anything only a human can
complete:

1. **Stop.** Do not retry, do not fill in credentials yourself, do not click
   around the prompt.
2. **Tell the user exactly what is needed and where** — which tab (give the
   URL), and what the page is asking for. Then wait for their confirmation.
3. **Resume from where you stopped**, re-reading the page state first: the
   user may have logged in, navigated elsewhere, or closed the tab.

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
also accepts `matches` and `contains`, and without either it checks only that
the element exists. An unknown `type` or a `js` check without `expression` is
reported as a malformed check rather than silently run. Every check accepts
`click` (`"selector"` or `{x,y}`) and `waitMs` to act before asserting, with
coordinates in `0..1` relative to the viewport. Read `passed`/`failed` — the
envelope's `ok: true` only means the command ran.

## Notes

- Every browser command is appended to a local audit trail (JSONL, one line
  per command: what, which tab, ok/failed, duration). If the user asks what
  was done to their browser, the file lives under the OS temp dir in
  `dsh-cdp-audit/` unless the host configured `auditDir`.
- `console` and `network` capture from the moment the page's session attaches,
  not from page load: output produced before the first command on that tab is
  not available, and the response says so. `network` keeps the last 500
  requests; a body is only readable while the browser still holds it, so
  `index` after a navigation may come back with `body: null`. `durationMs` is
  the whole request (measured when it finishes), `ttfbMs` the wait before the
  response began, `redirects` lists the hops before the final URL, and
  `fromCache` says the response never went to the network.
- `shot` with `fullPage: true` captures the whole document without resizing
  the page. Content that only loads when scrolled into view may be missing
  from it — if completeness matters, `wheel` down first and re-shoot, or take
  several viewport shots.
- `wheel` prefers a synthesized gesture (real `wheel` events, so custom scroll
  containers react) and falls back to scrolling in the page when the tab is not
  getting compositor input — its `via` field says which path ran.
- The plugin never launches a browser. If nothing is found, run `browsers` and
  give the user the printed launch command. A browser started with an explicit
  non-zero `--remote-debugging-port` is found on that port; otherwise discovery
  reads the profile's `DevToolsActivePort` file.
- On Chrome/Edge 136+ the default profile refuses an explicit debug port; the
  supported route there is the browser's own remote-debugging approval flow.
