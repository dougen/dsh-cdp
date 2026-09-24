# dsh-cdp

**English** · [中文](#中文)

Drive the Chromium browser you are **already using** from DSH — your logins, cookies, and extensions stay exactly where they are.

Works with Chrome, Edge, Brave, Vivaldi, Opera, Chromium, Arc, and Thorium.

## 1. What it does

DSH can read and operate the pages genuinely open in your browser: navigate, evaluate JS, read the DOM, click, type, screenshot, and run DOM / pixel assertions. So "what is on this page", "log in and pull the data down", "is this page rendering correctly" all run against your real session — no second, clean browser.

It targets the three usual pains of driving a browser over CDP:

| The usual approach | The problem | This plugin |
|---|---|---|
| Open a CDP connection per action | Chromium grants remote debugging **per connection** → a prompt every time | One long-lived connection + heartbeat keep-alive, **approve once** |
| Register browser abilities as tools / MCP | Every tool schema rides every request, a fixed token cost | **No new tools** — the agent uses the shell tool it already has |
| Browser extension + resident helper | One more extension dependency, an awkward install | **No runtime dependencies**, a plain plugin |

## 2. Install and remove

### Install

```sh
dsh plugin --profile web add dsh-cdp
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
dsh plugin --profile web remove dsh-cdp
```

Restart the Web GUI afterwards.

### What you may run into

| Symptom | Cause and handling |
|---|---|
| Grey icon / the panel says "Not connected" | The browser has no debug endpoint open. The panel prints the launch command for the browsers it found on this machine, ready to copy. |
| The panel says "Awaiting approval" | Switch to the browser window and click **Allow**. If no prompt is visible, check that the browser is not minimised or covered by another window. |
| A command returns `awaiting-approval` | Same as above. Have the user approve, then retry once — never in a loop. |
| The icon greys out after a browser restart | Expected; the plugin reconnects on its own, and the browser may ask for approval again. |
| The icon turns blue | The agent is driving your browser right now. It stays blue for about five seconds after the command finishes, then returns to the connection colour. |
| `--remote-debugging-port` will not attach to the default profile | An official Chrome/Edge 136+ restriction (it keeps malicious programs from reading cookies over the debug port). Use Option A. |
| `browsers` lists only some browsers | It lists what is genuinely installed and has a profile directory; pin one in `cordis.patch.yml`. |

The panel and every hint follow the Web GUI's language setting: Chinese and English switch automatically with the profile.

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

Because the connection is long-lived and heartbeated, Chromium's remote-debugging approval happens once, when the connection is established.

Two implementation details:

- **Discovery takes two paths.** By default it reads the `DevToolsActivePort` file under the browser's profile directory (written when the browser picks its own port); if the browser was started with an explicit non-zero `--remote-debugging-port`, it uses that port — in which case the browser **deliberately does not write** the file. The verdict is always "TCP reachable + WebSocket handshake succeeded".
- **"Awaiting approval" is a state of its own, not "cannot connect".** While the browser waits for approval the socket neither opens nor errors — it stays silent. The plugin puts a deadline on the handshake and classifies that silence as this state. The parked socket is **kept and reused**: once you click Allow it is adopted directly, which does not open another connection (that would raise a second prompt).

The `browser-cdp` skill tells the agent to treat your existing tabs as read-only: it may read them, but any page it changes goes in a tab it opens itself and closes when the work is done, so your own tabs are never navigated, typed into, or closed.

## License

MIT

---

## 中文

[English ↑](#dsh-cdp)

让 DSH 直接驱动你**已经在用的** Chromium 内核浏览器——保留你的登录态、cookie 和扩展。

支持 Chrome、Edge、Brave、Vivaldi、Opera、Chromium、Arc、Thorium。

## 一、它做什么

DSH 可以读取并操作你浏览器里真实打开的页面：导航、执行 JS、读取 DOM、点击、输入、截图，以及做 DOM / 像素断言。所以「看看这个页面上有什么」「登录后把数据抓下来」「这个页面渲染对不对」这类事情，用的是你真实的登录态，不需要另开一个干净的浏览器。

它针对用 CDP 操作浏览器的三个常见麻烦：

| 常见做法 | 问题 | 本插件 |
|---|---|---|
| 每次操作新建 CDP 连接 | Chromium 的远程调试授权是**按连接**的 → 每次都要弹窗 | 常驻一条连接 + 心跳保活，**授权一次** |
| 把浏览器能力注册成多个工具 / MCP | 每个工具的 schema 都进每一次请求，token 开销固定 | **零新增工具**，agent 用已有的 shell 工具调用 |
| 浏览器扩展 + 常驻监控程序 | 多一层扩展依赖，安装复杂 | **零运行时依赖**，纯插件 |

## 二、安装与卸载

### 安装

```sh
dsh plugin --profile web add dsh-cdp
```

装完重启 Web GUI（`dsh web`）后生效。

插件自带 `browser-cdp` skill，**无需另外安装 skill 文件**。

### 让浏览器可以被连接

插件**从不启动、也从不关闭**你的浏览器——它只连接你自己启动的实例。这一步在 DSH 之外完成，所以 agent 永远不会因此请求授权。

**方式 A：用浏览器自带的远程调试开关（推荐，保留登录态）**

在浏览器地址栏打开 `chrome://inspect`（Edge 是 `edge://inspect`），勾选允许远程调试。之后照常启动浏览器即可。

**方式 B：用独立配置目录启动（不弹窗，但没有现有登录态）**

```sh
msedge.exe --remote-debugging-port=9222 --user-data-dir="C:\edge-debug"
```

这是一个全新的配置目录，没有你现有的 cookie、登录态和扩展。适合测试。

### 卸载

```sh
dsh plugin --profile web remove dsh-cdp
```

重启 Web GUI 后生效。

### 可能遇到的情况

| 现象 | 原因与处理 |
|---|---|
| 图标是灰色 / 面板显示「未连接」 | 浏览器没有开启远程调试。面板会给出你机器上对应浏览器的启动命令，可一键复制。 |
| 面板显示「等待授权」 | 切到浏览器窗口点 **Allow**。若没看到弹窗，检查浏览器是否被最小化或被其他窗口遮挡。 |
| 命令返回 `awaiting-approval` | 同上。让用户点授权后再重试一次，不要循环重试。 |
| 浏览器重启后图标变灰 | 正常，插件会自动重连；必要时浏览器会再次询问授权。 |
| 图标变成蓝色 | agent 正在操作你的浏览器。命令结束后还会保持约 5 秒，然后回到连接状态的颜色。 |
| 无法用 `--remote-debugging-port` 连默认配置目录 | Chrome/Edge 136+ 的官方安全限制（防止恶意程序借调试端口读取 cookie），用上面方式 A。 |
| `browsers` 只列出部分浏览器 | 只会列出真实安装了且有配置目录的；可用 `cordis.patch.yml` 固定某个浏览器。 |

面板和所有界面提示跟随 Web GUI 的语言设置，中文与英文随配置文件自动切换。

## 三、工作原理

```
DSH 宿主进程
├── 唯一一条 CDP WebSocket（心跳保活）
├── /api/dsh-cdp          本机 HTTP 路由，仅接受回环 Host
└── 自带 browser-cdp skill
        ↑ agent 用已有 shell 工具调用（无新增工具）
        ↓
   你的浏览器（Chrome / Edge / Brave / …）
```

宿主进程内保持**唯一一条** CDP 连接，把浏览器操作挂在本机回环路由上。agent 用它已经有的 shell 工具（`Invoke-RestMethod`、`curl`）调用，所以新增的模型可见工具 schema 是 **0 个**；用法由随插件注册的 `browser-cdp` skill 说明，只在需要时加载。

因为连接是常驻的、并且带心跳保活，Chromium 的远程调试授权只在建立连接时发生一次。

两个实现细节：

- **浏览器发现走两路。** 默认读浏览器配置目录下的 `DevToolsActivePort` 文件（浏览器自选端口时写它）；若浏览器是用显式非零 `--remote-debugging-port` 启动的，则用该端口——此时浏览器**故意不写**那个文件。判定始终以「TCP 可连 + WebSocket 握手成功」为准。
- **「等待授权」是独立状态，不是「连不上」。** 浏览器等待授权时，socket 既不 `open` 也不 `error`，只是沉默。插件给握手设了期限，把这段沉默归类成该状态。被挂起的 socket 会**保留并复用**：你点 Allow 后直接接管，不会另开连接（那会弹出第二个授权框）。

`browser-cdp` skill 要求 agent 把已有标签页当作只读：可以读取，但任何会改变页面的操作都放在它自己新建的标签里进行，用完即关，所以你自己的标签不会被导航、输入或关闭。

## License

MIT
