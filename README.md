# @dougen/dsh-cdp

**English** · [中文](README.zh.md)

Drive the Chromium browser you are **already using** from DSH — your logins, cookies, and extensions stay exactly where they are.

Works with Chrome, Edge, Brave, Vivaldi, Opera, Chromium, Arc, and Thorium.

**Compatible with DSH 0.1.0 and later** — every `0.1.x` and `0.2.x` release, prereleases included.

## 1. What it does

DSH can read and operate the pages genuinely open in your browser: navigate, evaluate JS, read the DOM or the accessibility tree, click, hover, drag, type, press keys, screenshot, emulate a viewport or dark mode, read the console and network log, and run DOM / pixel assertions. So "what is on this page", "log in and pull the data down", "is this page rendering correctly" all run against your real session — no second, clean browser.

It targets the three usual pains of driving a browser over CDP:

| The usual approach | The problem | This plugin |
|---|---|---|
| Open a CDP connection per action | Chromium grants remote debugging **per connection** → a prompt every time | One long-lived connection + heartbeat keep-alive, **approve once** |
| Register browser abilities as tools / MCP | Every tool schema rides every request, a fixed token cost | **No new tools** — the agent uses the shell tool it already has |
| Browser extension + resident helper | One more extension dependency, an awkward install | **No runtime dependencies**, a plain plugin |

## 2. Install and remove

### Install

```sh
dsh plugin --profile web add @dougen/dsh-cdp
```

Restart the Web GUI (`dsh web`) afterwards.

The plugin ships its own `browser-cdp` skill — **there is no separate skill file to install**.

### Make the browser connectable

The plugin **never launches and never closes** your browser — it only attaches to an instance you started yourself. This step happens outside DSH, so the agent never triggers an approval for it.

**Option A: the browser's own remote-debugging switch (recommended, keeps your session)**

Open `chrome://inspect` (Edge: `edge://inspect`) in the address bar and allow remote debugging. Then start the browser as usual.

**Option B: launch with a separate profile directory (no prompt, but no existing session)**

```sh
msedge.exe --remote-debugging-port=9222 --user-data-dir="C:\edge-debug"
```

That is a brand-new profile directory: none of your current cookies, logins, or extensions. Good for testing.

### Remove

```sh
dsh plugin --profile web remove @dougen/dsh-cdp
```

Restart the Web GUI afterwards.

### What you may run into

| Symptom | Cause and handling |
|---|---|
| Grey icon / the panel says "Not connected" | Not attached to a browser. The panel's button — or any browser command — connects, and the browser asks for approval once. If no debug endpoint is found, enable remote debugging in `chrome://inspect`. |
| The panel says "Awaiting approval" | Switch to the browser window and click **Allow**. If no prompt is visible, check that the browser is not minimised or covered by another window. |
| A command returns `awaiting-approval` | Same as above. Have the user approve, then retry once — never in a loop. |
| The icon turns grey after a browser restart | Expected; the plugin does not attach by itself. The next browser command (or **Connect browser** in the panel) opens a new connection, and the browser asks for approval once. |
| The icon turns blue | The agent is driving your browser right now. It stays blue for about five seconds after the command finishes, then returns to the connection colour. |
| `--remote-debugging-port` will not attach to the default profile | An official Chrome/Edge 136+ restriction (it keeps malicious programs from reading cookies over the debug port). Use Option A. |
| `browsers` lists only some browsers | It lists what is genuinely installed and has a profile directory; pin one in `cordis.patch.yml`. |

The plugin title, description, panel, and this README follow the Web GUI's language setting: Chinese renders in Chinese; every other language renders in English.

## 3. How it works

```
DSH host process
├── the one and only CDP WebSocket (heartbeat keep-alive)
├── /api/dsh-cdp          loopback HTTP route, loopback Host only
└── the bundled browser-cdp skill
        ↑ the agent calls it with the shell tool it already has (no new tools)
        ↓
   your browser (Chrome / Edge / Brave / …)
```

The host process holds **exactly one** CDP connection and mounts browser operations on a loopback route. The agent calls it with the shell tools it already has (`Invoke-RestMethod`, `curl`), so the number of new model-visible tool schemas is **0**; usage is described by the `browser-cdp` skill the plugin registers, loaded only when it is needed.

Because the connection is long-lived and heartbeated, Chromium's remote-debugging approval happens once per browser session — when the connection is established. Attaching is demand-driven: the plugin never connects on its own, so merely launching the browser raises no prompt. The next browser command (or the panel's **Connect browser** button) is what opens the connection and asks for approval.

Two implementation details:

- **Discovery takes two paths.** By default it reads the `DevToolsActivePort` file under the browser's profile directory (written when the browser picks its own port); if the browser was started with an explicit non-zero `--remote-debugging-port`, it uses that port — in which case the browser **deliberately does not write** the file. The verdict is always "TCP reachable + WebSocket handshake succeeded".
- **"Awaiting approval" is a state of its own, not "cannot connect".** While the browser waits for approval the socket neither opens nor errors — it stays silent. The plugin puts a deadline on the handshake and classifies that silence as this state. The parked socket is **kept and reused**: once you click Allow it is adopted directly, which does not open another connection (that would raise a second prompt). The state is not a dead end either: a socket that dies, or stays silent well past any plausible prompt (90s), is dropped — and nothing re-attaches until a command (or the panel's Connect button) asks for one. Chromium asks for approval per connection, so re-attaching on the plugin's own initiative would raise the prompt on every browser launch.

The `browser-cdp` skill keeps the agent off your tabs by mechanism, not by convention: read commands may inspect any page, while every command that changes what the page shows — navigation, clicks, typing, hovering, scrolling, uploads, viewport/media overrides, closing, and dialog answers — is accepted only on a tab the plugin opened itself. Every command that reaches the browser is also appended to a local audit trail.

## License

MIT
