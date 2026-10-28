# Browser control over CDP

Drive a Chromium-family browser already running on this machine. The plugin
attaches to whichever one has remote debugging enabled; it never launches one,
and it holds a single long-lived connection so the browser asks for approval
once. It also never connects on its own: attaching happens only for a command
that needs the browser (or when the user clicks Connect in the panel), so merely
opening the browser raises no prompt.

## Calling convention

Send one command per shell call to the loopback route: the command name in
`?cmd=`, its arguments as a JSON object body. There are no browser-specific
tools — this route is the only way in.

```powershell
# PowerShell 7+. -SkipHttpErrorCheck is 7-only: without it a 409 surfaces as an
# exception instead of a body. The braces around ${base} matter: PowerShell
# variable names may contain "?", so "$base?cmd=..." interpolates the wrong
# variable and the call fails on an unparsable URI.
$base = $env:DSH_WEB_URL + '{{routePath}}'
function Cdp([string]$Cmd, [hashtable]$Body = @{}) {
  Invoke-RestMethod -Uri "${base}?cmd=$Cmd" -Method Post -ContentType 'application/json' `
    -Body ($Body | ConvertTo-Json -Compress -Depth 6) -SkipHttpErrorCheck
}

Cdp status | ConvertTo-Json -Depth 6                       # read: never attaches
$tab = (Cdp open @{ url = 'https://example.com' }).id      # write: own a tab
Cdp snapshot @{ tabId = $tab; aria = $true; limit = 40 }   # refs to act on
Cdp click @{ tabId = $tab; ref = 'e5' }
Cdp wait @{ tabId = $tab; text = 'Saved' }
Cdp close @{ tabId = $tab }
```

Each shell call is a fresh process, so this helper does not survive between
calls: define it and run the whole sequence in one call. Build the body with
`ConvertTo-Json`, never by hand — a page expression usually contains a quote.
On macOS/Linux the same request is
`curl -s -X POST "$DSH_WEB_URL{{routePath}}?cmd=$cmd" -H 'content-type: application/json' -d "$body"`.

**The HTTP status is not the result.** A failed command still answers HTTP 200
with `{ok:false, error, message}`; result fields are flattened into the
envelope, so you read `$r.pages`, `$r.status.state`, `$r.value`. Check `ok`
first, then `error`: `awaiting-approval`, `unreachable`, `protocol`, `aborted`,
or `command-failed` — `message` says what actually went wrong. The only non-200
answer is a browser waiting at its remote-debugging prompt: **HTTP 409** with
`error: "awaiting-approval"`, a body you only see with `-SkipHttpErrorCheck`.
Tell the user to click **Allow** in the browser window, then retry once;
retrying cannot approve anything, so a loop just spams them. `unreachable`
usually means no browser is attached: run `browsers`, and offer the user the
launch command it prints.

Two answers look like success but are not: `status`/`connect`/`reconnect`/
`stop` return `ok:true` even when nothing is connected — read `status.connected`
instead; and `wait` reports a timeout as `{ok:false, waitedMs}` with no
`error`/`message`, which is how you tell "still waiting" from "the command
failed".

Connecting is lazy: the first command that needs the browser attaches, so
`status` reporting `idle` is normal and means no prompt has been raised yet.
Nothing attaches on its own — not at plugin load, and not after the browser
restarts — so a browser that was merely reopened carries no permission request.
The next command opens the connection and the browser asks for approval once
for it. `status` and `browsers` read only local state and answer without joining
the command queue; every other command is serialised, so a long `wait` holds the
next one.

## Which tabs you may touch

The browser holds the user's own session, so pages already open may be in
active use. The plugin enforces the boundary rather than trusting prose.

- **Reads work on any tab.** `tabs` (its `owned` flag tells you which tabs
  writes may target), `snapshot`, `shot`, `console`, `network`, `wait`, and an
  `eval` that only inspects. But omitting `tabId` is not neutral: a read falls
  back to the first page the browser reports, which is usually the user's tab.
  Pass the id whenever more than one page is open.
- **Writes need a tab you opened.** `goto`, `back`/`forward`, `click`, `hover`,
  `drag`, `wheel`, `type`, `key`, `select`, `upload`, `resize`, `media`,
  `close`, an answering `dialog`, and any `assert` whose checks carry `click`
  must pass the `tabId` of a tab created by `open` in this session. Omitting it
  is an error, not a fallback to the first page.
- **`activate` is allowed on any tab.** A background tab's timers and frames
  are throttled, so raise the tab before shooting or asserting on it. It does
  switch what the user is looking at, which is why it is an explicit call.
- **Why `hover`, `wheel`, `resize`, and `media` count as writes:** they change
  what the user sees without changing data — a menu opens, the page moves and
  may lazy-load, the layout reflows, the colour scheme changes.
- **To act on a page that is already open, `open` it again by URL.** The new
  tab is authenticated too, because the login state belongs to the browser, and
  `open` raises it. Read the `url` from `tabs`; do not drive the original tab.
- **Close what you opened, in the turn that opened it.** A tab left behind is a
  visible change to the user's browser. After `reconnect` or `stop` your
  earlier tabs are no longer owned, so `close` will refuse them — tell the user
  which URL was left open. Ownership survives a dropped socket, because the
  plugin does not re-attach by itself: the next command reconnects and keeps the
  grant, but the old tab may be gone, so re-check `tabs` before reusing its id.
- `eval` and `wait`'s `expression` have no read/write distinction, so the guard
  cannot apply to them. Keep them side-effect free on tabs you did not open.

## Commands that only read

`tabId` is optional here; pass it whenever more than one page is open.

| cmd | body | returns |
|---|---|---|
| `status` | — | `state`, `connected`, `authorized`, `busy`, `browser`, `endpoint`, `connectedFor`, `pageCount`, `error`; never attaches |
| `browsers` | — | every known Chromium profile, whether its debug port is listening, and a launch hint; never attaches |
| `tabs` | — | `pages[]`: `id`, `title`, `url`, `owned` |
| `activate` | `tabId?` | the raised tab: `active`, `url` |
| `eval` | `expression`, `tabId?`, `awaitPromise?` | `value` — always a string — plus `kind`: `value` is JSON-serialised (`undefined` becomes `"null"`), `unserializable` is `"NaN"`/`"123n"`, `object` is a value with no JSON form whose detail is in `description`/`subtype` |
| `snapshot` | `tabId?`, `limit?`, `aria?`, `boxes?` | `tree` (an indented string), `title`, `url`, `nodes`, `truncated`, `mode`; `aria:true` yields `[ref=eN]` handles and adds `refs`; `boxes:true` appends each ref's viewport box |
| `shot` | `tabId?`, `fullPage?`, `out?` | `path` to a PNG plus `width`, `height`, `bytes`; `out` is a directory relative to the host's shot dir, and escaping it is refused |
| `console` | `tabId?`, `level?`, `limit?` | `entries[]`, `dialogs[]`, `pendingDialog`, `count`, `captured`, `trimmed`, `note`; `level` matches exactly (`log`/`debug`/`info`/`warning`/`error`) |
| `dialog` | `tabId?` | `pending` dialog (if any), `dialogs[]`, `url`; adding `accept`/`dismiss` turns it into a write |
| `network` | `tabId?`, `index?`, `filter?`, `limit?` | numbered `requests[]`, or one request in full with its `body`; `filter` is a URL regex; `index` is the request's number, not its position in the filtered list |
| `wait` | one of `text`, `textGone`, `selector` (+ `gone`), `expression`; `timeoutMs?`, `pollMs?`, `tabId?` | `ok`, `waitedMs` |
| `assert` | `checks[]` (at most 50), `tabId?` | `passed`, `failed`, `total`, `results[]`; a check carrying `click` makes the whole call a write |

`connect`, `reconnect`, and `stop` take no `tabId` and return `status`.

The DOM outline stops at 8 levels deep and skips `script`/`style`/`noscript`;
its `truncated` compares the document's element count with `limit`, so it means
"there may be more", not "this many were dropped". In `aria` mode `truncated`
means the ref budget was reached.

## Commands that change the page

Every command below takes `tabId` — the `id` returned by `open` — except `open`
itself, which creates that tab. Only a tab this session opened is accepted.

| cmd | body | returns |
|---|---|---|
| `open` | `url`, `settleMs?` | creates a tab, raises it, navigates: `id` (the `tabId`) and `url`. A failed navigation closes the tab; if it cannot be closed the error names the id |
| `goto` | `url`, `tabId`, `settleMs?` | `id` and the url you passed, not the final redirect target |
| `back` / `forward` | `tabId` | `id`, `url` of the history entry; an error at either end of history |
| `close` | `tabId` | `closed` |
| `click` | exactly one of `selector`, `ref`, or `x`+`y`; `tabId`, `doubleClick?`, `clickCount?`, `button?`, `modifiers?` | `clicked` |
| `hover` | `ref`/`selector` or `x`+`y`; `tabId` | `hovered` |
| `drag` | `fromSelector`/`fromRef`/`fromX`+`fromY` and `toSelector`/`toRef`/`toX`+`toY`, `steps?`, `modifiers?`, `tabId` | the two endpoints in pixels |
| `wheel` | `deltaX`, `deltaY`, `x?`, `y?`, `tabId` | `scrolled`, `via` (`gesture` / `page` / `page-partial`), `cancelledByPage` |
| `type` | `text`, `selector?`/`ref?`, `submit?`, `pressAfter?`, `delayMs?`, `tabId` | `typed`, plus `submitted`/`pressed` when one was sent; `\n` and `\t` become Enter and Tab |
| `key` | `key` (`Enter`, `Escape`, `Tab`, `Ctrl+A`, …), `selector?`/`ref?`, `tabId` | `key`, `modifiers` |
| `select` | `selector`, `value` or `values`, `byLabel?`, `tabId` | the value(s) actually set; a multiple select clears the others first |
| `upload` | `selector`, `files[]` (absolute paths), `tabId` | files attached by path |
| `resize` | `width`+`height` (numbers), `mobile?`, `deviceScaleFactor?`, or `clear:true`; `tabId` | the emulated viewport, or `cleared: true` |
| `media` | `colorScheme?`, `reducedMotion?`, `forcedColors?`, `contrast?`, `media?`; `tabId` | the emulated media state; no fields clears it |
| `assert` | `checks[]` with at least one `click`, `tabId` | as in the read table |

All coordinates are viewport CSS pixels — the numbers `getBoundingClientRect()`
returns, or what `snapshot` with `boxes:true` prints. The one exception is a
`pixel` check, whose `x`/`y` are fractions of the screenshot.

`open` and `goto` wait for the load event (up to 10 s) and then `settleMs`
(default 400 ms); `back`/`forward` wait for load too. For content that arrives
after load, use `wait` instead of a bigger delay.

## Prefer `wait` over fixed delays

`wait` polls in the page and returns as soon as its condition holds, so it is
faster and steadier than a guessed `settleMs`:

```json
{"text": "Saved"}                        // innerText contains it
{"textGone": "Loading…"}                 // absent, and the document has parsed
{"selector": "#results tbody tr"}        // appears
{"selector": ".spinner", "gone": true}   // gone
{"expression": "document.readyState === 'complete'"}
```

Several fields in one call must all hold (they are ANDed). `timeoutMs` defaults
to 8 s and is capped there — a larger value is silently clamped, so real
patience needs a decision, not a bigger number. A timeout is a normal answer
`{ok:false, waitedMs}` with no `error`; read the page (`snapshot`, `console`)
and decide whether to wait again, act, or report that it is slow. Never answer
a timeout with a blind retry loop.

`wait` may run on any tab, including the user's — but its `expression` is
arbitrary page JS, so keep that side-effect free there.

## Refs: aim at what the page means, not at a CSS path

`snapshot` with `"aria": true` returns the accessibility tree, and every node
that can be acted on carries a `[ref=eN]` handle:

```
- navigation [ref=e2]
  - link "Home" [ref=e3]
- button "Save" [ref=e5]
- textbox "Search" [ref=e7]
```

Pass that `ref` to `click`, `hover`, `type`, `key`, `drag`, and a check's
`click`. A ref survives markup churn that would break a CSS path — an extra
wrapper `div` changes every selector but not the role/name pair. The commands
whose `selector` has no `ref` alternative are `select`, `upload`, `wait`, and a
check's own `selector`.

Numbers are never reused within a page session, so a stale ref is reported as
unknown instead of quietly pointing at whatever now occupies that position. Two
boundaries: a navigation voids the refs, so take a fresh snapshot; and after
`reconnect` or a dropped connection the numbering restarts, so an old `e1` may
name a different node — snapshot again after reconnecting. One session holds at
most 800 refs; nodes past that have no handle.

`boxes: true` appends each ref's viewport box, `{x:… y:… w:… h:…}` in CSS
pixels — that is where a coordinate click comes from. It costs one extra round
trip per node, so opt in only when you need pixels.

## Assertion checks

```json
{"checks": [
  {"name": "header", "type": "css", "selector": "h1", "property": "color", "equals": "rgb(0, 0, 0)"},
  {"name": "present", "type": "dom", "selector": "#app", "text": "Ready"},
  {"name": "no-error", "type": "dom", "selector": ".error", "absent": true},
  {"name": "pixel", "type": "pixel", "x": 0.5, "y": 0.1, "color": "#ffffff", "tolerance": 12}
]}
```

`type` defaults to `js`: an `expression` that is truthy, or matches `equals`
(compared by JSON serialisation, so `1` and `"1"` differ). `css` reads the
computed `property` and compares it with `equals`, `matches` (a regex) or
`contains`, or just checks that the element exists. `dom` checks presence, that
some match contains `text`, or `absent: true`. `pixel` samples the current
screenshot with `x`/`y` as **fractions (0..1) of the image** (a value above 1
is read as pixels), `color` as `#rrggbb`, and an optional `tolerance` (default
16). A malformed check — an unknown `type`, or `js` without `expression` — is
reported as one failed check, not as a failed command.

A check may carry `click` before asserting: a selector string, `{ref}`, or
`{x,y}` in **viewport CSS pixels**, not fractions. That is the one coordinate
rule to get right: only `pixel` sampling is proportional. A click waits 150 ms
by default; `waitMs` overrides it.

Read `passed`/`failed`/`results`; every check reports `ok`, `expected`,
`actual`, `ms`, and `error` when it threw. The envelope's `ok: true` only means
the command ran — a page that renders wrong still returns `ok: true` with
failed checks.

## Dialogs

A JavaScript `alert`/`confirm`/`prompt` blocks its tab: while one is open, no
protocol call to that page completes. On a tab you opened, the plugin answers
the dialog for you — `dismiss` by default, so the page continues down its
cancel path — and records it; `console` lists the records under `dialogs`.
While a page session is live, a dialog on your own tab therefore usually never
shows up as `pending`.

On a tab you did **not** open, dialogs are recorded but never answered: that is
the user's page, and pressing OK on their unsaved-work prompt from a plugin is
a write to their session. Tell the user what the page is asking and let them
answer it in the browser.

`dialog` with no `accept`/`dismiss` reports `pending` on any tab. Answering is
possible only on a tab you opened, and only when the host set
`dialogPolicy: 'ignore'` — with the default `'dismiss'` the plugin has already
answered, so `accept`/`dismiss` then fails with "no dialog is waiting".

## Emulated viewport and media

`resize` and `media` override one page session. The override lasts until you
clear it or the session ends, and it is not saved into the user's profile — but
while it is active that tab really renders at the new size and colour scheme,
which is why both are writes and need your own tab. A later `shot` or `pixel`
check sees the overridden rendering too, so clear it before finishing.

```json
{"width": 375, "height": 700}   // a phone breakpoint
{"clear": true}                 // back to the real viewport
{"colorScheme": "dark"}         // prefers-color-scheme: dark
{"media": "print"}              // the print stylesheet
```

`width` and `height` must be numbers — a string or a boolean is refused rather
than coerced. Media values come from the CSS vocabulary: `colorScheme`
`light`/`dark`; `reducedMotion` `no-preference`/`reduce`; `forcedColors`
`none`/`active`; `contrast` `no-preference`/`more`/`less`/`custom`; `media`
`screen`/`print`. Anything else is rejected, because the browser accepts a
wrong value silently and simply never matches it. A `media` call with no fields
clears the override.

## Uploading files

`upload` attaches files to a file input by absolute path. The paths must be
inside the directories the host configured (`uploadRoots`); anything else is
refused, and with no roots configured the command is off — ask the user to set
`uploadRoots` rather than guessing. The plugin runs outside the agent's file
sandbox, so the boundary is set by the host rather than per request.

```json
{"selector": "#avatar", "files": ["C:\\Users\\me\\pictures\\a.png"]}
```

Each file must exist and be a regular file; the error names the path it could
not read, and UNC or device paths are refused.

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
  several questions deterministically.
- `snapshot` defaults to 80 DOM nodes (120 in `aria` mode) and caps at 400;
  start at `limit: 30`–`40`. Once you need to act, prefer `aria: true`: refs
  are shorter than CSS paths and survive markup churn. Add `boxes` only when
  you need pixel coordinates.
- Responses are clipped to about 24 KB; `console` and `network` say `trimmed`
  when that happened. Narrow with `level`/`filter`, lower `limit`, or fetch one
  `network` entry by `index` instead of the list.
- In `eval`, return exactly the fields you need (`({t: document.title})`); a
  DOM node has no JSON form and comes back as an opaque placeholder, so read
  what you need in the page instead. Numbers arrive as strings.

## Notes

- Every command that touches the browser is appended to a local audit trail:
  one JSONL line per command in `audit-YYYY-MM-DD.jsonl` (command, tab,
  ok/failed, duration — never the arguments). It lives under the OS temp dir in
  `dsh-cdp-audit/` unless the host configured `auditDir`; `status` and
  `browsers` are not audited. This is the file to read if the user asks what
  was done to their browser.
- `console` and `network` capture from the moment that tab's page session
  attaches, not from page load. Because `open` attaches before it navigates,
  your own tab captures its loading output; a page that was already open only
  has output from the first command onward. `console` keeps the last 200 lines
  (`level` matches exactly, `limit` defaults to 100); `network` keeps the last
  500 requests. A response body is readable only while the browser still holds
  it, so `index` after a navigation may come back with `body: null`.
  `durationMs` is the whole request, `ttfbMs` the wait before the response
  began, `redirects` lists the hops before the final URL, and `fromCache` says
  the response never went to the network.
- `shot` with `fullPage: true` captures the whole document without resizing the
  page. It clamps the capture to 8000 px in each direction and sets `truncated`
  when either edge was cut. Content that only loads when scrolled into view may
  be missing — `wheel` down first (on your own tab) and re-shoot, or take
  several viewport shots.
- `wheel` prefers a synthesized gesture (real `wheel` events, so custom scroll
  containers react) and falls back to scrolling in the page when the gesture
  moved nothing — its `via` field says which path ran. Zero deltas are a no-op
  that still reports success.
- The plugin never launches a browser. `browsers` lists every known Chromium
  profile on this machine, installed or not, with whether its debug port is
  listening and a copy-ready launch command; that command uses port 9222, so
  change it if the port is taken. A browser started with an explicit non-zero
  `--remote-debugging-port` is found only on a port the host lists (9222 by
  default) and only if that build serves `/json/version`; otherwise discovery
  reads the profile's `DevToolsActivePort` file.
- On Chrome/Edge 136+ the default profile refuses an explicit debug port. The
  supported route is the browser's own switch: have the user open
  `chrome://inspect` (Edge: `edge://inspect`), allow remote debugging, keep the
  browser running, then `connect`.
