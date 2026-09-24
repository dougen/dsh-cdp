/**
 * dsh-cdp — host half.
 *
 * Owns ONE long-lived CDP connection to a Chromium browser the user already
 * started, and exposes browser commands to the agent over a loopback HTTP
 * route.
 *
 * Why this shape:
 *
 *  - **One connection, not one per command.** Chromium prompts for remote
 *    debugging per *connection*, so a plugin that reconnects per command makes
 *    the user click Allow constantly. Holding the socket and heartbeating it
 *    turns "approve every action" into "approve once per browser session".
 *
 *  - **A route instead of tools.** Registering browser tools would add their
 *    schemas to every single model request. The agent already has `pwsh`, so a
 *    loopback route costs zero new tool schemas.
 *
 *  - **Writes happen here.** This plugin runs in the host process, which is not
 *    confined by the agent's sandbox. Screenshots therefore get written by the
 *    plugin and reported as a path, never inlined as base64 — base64 in the
 *    transcript would be resent on every later request.
 *
 * The plugin never launches or kills a browser. Attaching to a browser the user
 * started is plain loopback I/O, which keeps it approval-free at use time.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CdpConnection,
  CdpError,
  FailureKind,
  clickAt,
  decodePng,
  evaluate,
  navigate,
  runChecks,
  screenshot,
  typeText,
  withPage,
} from './cdp.js'
import { discover, probeHttpVersion, readActivePort, tcpProbe } from './discover.js'

export const name = 'dsh-cdp'
export const inject = ['webServer']

/**
 * Connection states the panel renders.
 *
 * `Idle` is the initial state and is distinct from `Disconnected`: nothing has
 * been attempted yet, so no request to attach has been made and the browser has
 * never been asked for control. The distinction is what lets the plugin load
 * without prompting — the first real command is what moves it out of `Idle`.
 */
const State = {
  Idle: 'idle',
  Disconnected: 'disconnected',
  Connecting: 'connecting',
  AwaitingApproval: 'awaiting-approval',
  Connected: 'connected',
  Error: 'error',
}

const ROUTE_PATH = '/api/dsh-cdp'
const HEARTBEAT_MS = 20_000
const OPEN_TIMEOUT_MS = 4_000
const CALL_TIMEOUT_MS = 10_000
const RECONNECT_BASE_MS = 3_000
const RECONNECT_MAX_MS = 60_000
/** Fixed retry cadence while no browser is discoverable at all. */
const DISCOVERY_POLL_MS = 5_000
/**
 * How long the activity flag stays raised after a browser command settles.
 *
 * A command can finish in a few milliseconds while the browser half polls the
 * status route every couple of seconds, so a flag scoped strictly to the
 * command's own lifetime would usually be gone before anyone could see it.
 * Holding it past one poll period turns "the agent just touched the browser"
 * into an observable state instead of a flicker.
 */
const ACTIVITY_HOLD_MS = 5_000
/**
 * Commands that never attach to the browser, and so never count as activity.
 *
 * The exemption is load-bearing twice over: these two carry a contract that
 * they read local state only (polling must never raise the remote-debugging
 * prompt), and the panel polls `status` continuously — counting it would let
 * the panel's own poll keep the icon lit forever.
 */
const OBSERVATION_COMMANDS = new Set(['status', 'browsers'])
/** Default cap on a single command's serialized response. */
const DEFAULT_MAX_OUTPUT_BYTES = 24_000
/** Cap on the accessibility/DOM snapshot before it is trimmed further. */
const SNAPSHOT_NODE_LIMIT = 400

/**
 * Default configuration.
 *
 * Deliberately NOT exported as `Config`: cordis treats a plugin's `Config`
 * export as a Standard Schema and calls `Config['~standard'].validate()`, so a
 * plain defaults object under that name fails the whole plugin tree at boot.
 */
export const Defaults = {
  /** Pin one Chromium profile instead of scanning the catalog. */
  dataDir: undefined,
  /** Extra candidate ports probed when no port file is found. */
  ports: [9222],
  /** Extra profile directories appended to the catalog. */
  extraDirs: [],
  /** Preferred browser id from the catalog (e.g. `chrome`, `brave`). */
  browser: undefined,
  /**
   * Connect during plugin startup instead of on first use.
   *
   * Defaults to `false`: attaching on load would make the browser raise its
   * remote-debugging prompt the moment the GUI starts, for a capability the
   * session may never use. With it off, the first browser command is what
   * triggers the request, so the prompt appears when it is actually wanted.
   */
  autoConnect: false,
  /** Heartbeat period; also the keep-alive that preserves the approval. */
  heartbeatMs: HEARTBEAT_MS,
  /**
   * How long the activity flag outlives the command that raised it.
   *
   * Applicable to both halves: the host reports `busy` from it, and the browser
   * icon polls for that. Zero disables the activity indicator.
   */
  activityHoldMs: ACTIVITY_HOLD_MS,
  /** Route carrying agent commands. */
  routePath: ROUTE_PATH,
  /** Per-command response cap in bytes. */
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  /** Directory screenshots are written to. */
  shotDir: undefined,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reject anything that is not a loopback Host header (DNS-rebinding guard). */
function isLocalHost(req) {
  const raw = req.headers.host
  if (typeof raw !== 'string' || raw === '') return false
  let host = raw.toLowerCase()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end === -1) return false
    host = host.slice(1, end)
  } else {
    const idx = host.lastIndexOf(':')
    if (idx !== -1) host = host.slice(0, idx)
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

/** Human-readable elapsed time, kept short for the panel. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** Trim a string to a byte budget without splitting a surrogate pair. */
function clipText(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid
    else high = mid - 1
  }
  return `${text.slice(0, low)}…[truncated]`
}

// ---------------------------------------------------------------------------
// Connection owner
// ---------------------------------------------------------------------------

/**
 * Holds the single CDP connection and its lifecycle.
 *
 * The state machine is deliberately explicit. Two states carry meaning that a
 * plain "connected / not connected" would lose:
 *
 *   - `idle` — nothing has been attempted. The browser has not been asked for
 *     control, so no prompt has been raised. This is the state a freshly
 *     loaded plugin sits in, and the reason loading it is silent.
 *   - `awaiting-approval` — a socket is parked on the browser's approval
 *     prompt, which neither opens nor errors. Collapsing that into "not
 *     connected" would leave the user with no idea a dialog is waiting.
 */
class BrowserSession {
  #ctx
  #config
  #connection = null
  #state = State.Idle
  #browser = null
  #endpoint = null
  #connectedAt = null
  #lastHeartbeatAt = null
  #lastError = null
  #awaitingHint = null
  #heartbeatTimer = null
  #reconnectTimer = null
  #reconnectDelay = RECONNECT_BASE_MS
  #connecting = null
  #queue = Promise.resolve()
  #pageCount = 0
  /** Browser commands currently in flight (nested calls are counted, not flagged). */
  #activeDepth = 0
  /** When the activity flag goes quiet; null before any browser command. */
  #activeUntil = null
  #shotDir
  #maxOutputBytes

  constructor(ctx, config) {
    this.#ctx = ctx
    this.#config = config
    // Screenshots are written by the host process — never by the agent — and
    // reported as a path. The default lives beside the OS temp dir.
    this.#shotDir = config.shotDir ?? join(tmpdir(), 'dsh-cdp-shots')
    this.#maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  }

  /** The resolved configuration this session runs with. */
  get config() {
    return this.#config
  }

  /** Where screenshots are written. */
  get shotDir() {
    return this.#shotDir
  }

  /** Per-command response cap in bytes. */
  get maxOutputBytes() {
    return this.#maxOutputBytes
  }

  get state() {
    return this.#state
  }

  /**
   * Whether the agent is driving the browser right now (or just did).
   *
   * Deliberately independent of `state`: a command that failed still counts,
   * because the agent did reach for the browser, and the flag is what the
   * composer icon reports.
   *
   * @param now - current epoch ms; injected so callers read one clock.
   */
  busy(now) {
    if (this.#activeDepth > 0) return true
    if (this.#activeUntil === null) return false
    return now < this.#activeUntil
  }

  /**
   * Mark the start of one browser command.
   *
   * Counted rather than assigned so nested and concurrent calls cannot clear
   * each other: the flag is only released by the last one out.
   */
  beginActivity() {
    this.#activeDepth += 1
  }

  /** Mark the end of one browser command and start the hold window. */
  endActivity(now) {
    this.#activeDepth = Math.max(0, this.#activeDepth - 1)
    this.#activeUntil = now + (this.#config.activityHoldMs ?? ACTIVITY_HOLD_MS)
  }

  /** Run commands one at a time so concurrent callers cannot interleave CDP state. */
  serialize(task) {
    const run = this.#queue.then(task, task)
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** The status payload shared by the panel and the `status` command. */
  snapshot() {
    const now = Date.now()
    return {
      state: this.#state,
      // `idle` means no attach has been attempted, so `disconnected` below is
      // about a browser that was looked for and not found.
      idle: this.#state === State.Idle,
      connected: this.#state === State.Connected,
      // Reaching `connected` means the browser accepted the connection, which
      // in approval mode is exactly the authorization grant.
      authorized: this.#state === State.Connected,
      // A browser command is running, or ran recently enough to still be worth
      // showing. Distinct from `state`: being connected is a standing fact,
      // whereas this is "the agent is acting on your browser right now".
      busy: this.busy(now),
      /** When `busy` lapses; null before the first browser command. */
      activeUntil: this.#activeUntil,
      browser: this.#browser?.name ?? null,
      browserId: this.#browser?.id ?? null,
      endpoint: this.#endpoint,
      connectedAt: this.#connectedAt,
      connectedFor: this.#connectedAt === null ? null : formatDuration(now - this.#connectedAt),
      lastHeartbeatAt: this.#lastHeartbeatAt,
      lastHeartbeatAgo: this.#lastHeartbeatAt === null ? null : formatDuration(now - this.#lastHeartbeatAt),
      pageCount: this.#pageCount,
      awaitingApprovalHint: this.#awaitingHint,
      error: this.#lastError,
      reconnectDelayMs: this.#reconnectDelay,
    }
  }

  /**
   * Discover a browser and connect. Safe to call repeatedly.
   *
   * Bails out while an approval prompt is pending: the parked socket already
   * holds the user's prompt, and re-running discovery would open a *second*
   * connection and raise a duplicate dialog.
   */
  async connect() {
    if (this.#state === State.Connected || this.#state === State.AwaitingApproval) return
    if (this.#connecting !== null) return this.#connecting
    this.#connecting = this.#connectOnce().finally(() => {
      this.#connecting = null
    })
    return this.#connecting
  }

  async #connectOnce() {
    this.#state = State.Connecting
    this.#lastError = null
    this.#awaitingHint = null

    const { candidates } = await discover({
      extraDirs: this.#config.extraDirs,
      ports: this.#config.ports,
      includeHttp: true,
      explicitDataDir: this.#config.dataDir,
    })

    if (candidates.length === 0) {
      this.#state = State.Disconnected
      this.#browser = null
      this.#endpoint = null
      this.#lastError = 'no CDP endpoint found'
      this.#awaitingHint = null
      // Keep looking: the user may start a browser after the plugin loaded,
      // and the panel should recover on its own rather than needing a command
      // or a manual retry. Discovery is cheap, so poll briskly.
      this.#scheduleReconnect(DISCOVERY_POLL_MS)
      return
    }

    // Prefer the configured browser, else the first candidate that answers.
    const preferred =
      this.#config.browser === undefined
        ? candidates
        : [
            ...candidates.filter((c) => c.browser.id === this.#config.browser),
            ...candidates.filter((c) => c.browser.id !== this.#config.browser),
          ]

    for (const candidate of preferred) {
      const connection = new CdpConnection(candidate.url, { callTimeoutMs: CALL_TIMEOUT_MS })
      try {
        await connection.open({ timeoutMs: OPEN_TIMEOUT_MS })
      } catch (error) {
        if (error instanceof CdpError && error.kind === FailureKind.AwaitingApproval) {
          // Hold the socket: the browser is showing an approval prompt for it,
          // and closing now would throw away the user's pending choice.
          this.#connection = connection
          this.#state = State.AwaitingApproval
          this.#browser = candidate.browser
          this.#endpoint = `127.0.0.1:${candidate.port}`
          this.#awaitingHint =
            'Waiting for approval — switch to the browser window and click "Allow" on the remote debugging prompt.'
          this.#scheduleApprovalWatch()
          return
        }
        connection.close()
        this.#lastError = error instanceof Error ? error.message : String(error)
        continue
      }

      // Handshake succeeded: this socket is the one long-lived connection, and
      // reaching here IS the authorization grant in approval mode.
      await this.#markConnected(connection, candidate.browser, candidate.port)
      return
    }

    if (this.#state !== State.AwaitingApproval) {
      this.#state = State.Error
      this.#browser = null
      this.#endpoint = null
      this.#reconnectDelay = RECONNECT_BASE_MS
      this.#scheduleReconnect()
    }
  }

  /**
   * Promote the parked socket once the user approves.
   *
   * The socket the handshake timed out on is still live and still holds the
   * browser's approval prompt, so it is adopted directly. Opening a fresh
   * connection here would raise a *second* prompt and lose the first.
   */
  #scheduleApprovalWatch() {
    const connection = this.#connection
    if (connection === null) return
    clearInterval(this.#heartbeatTimer)
    this.#heartbeatTimer = setInterval(async () => {
      if (this.#state !== State.AwaitingApproval) {
        clearInterval(this.#heartbeatTimer)
        return
      }
      try {
        await connection.waitForOpen({ timeoutMs: 1200 })
      } catch {
        return
      }
      clearInterval(this.#heartbeatTimer)
      // The browser completed the handshake: approval was granted.
      const parts = (this.#endpoint ?? '').split(':')
      await this.#markConnected(
        connection,
        this.#browser ?? { id: 'unknown', name: 'Chromium browser' },
        Number(parts[1] ?? 9222),
      )
    }, 2000)
    this.#heartbeatTimer.unref?.()
  }

  /**
   * Schedule the next discovery/connect attempt.
   *
   * Two cadences, because the two cases differ in cost and in how likely they
   * are to resolve soon:
   *
   *  - **Nothing found yet** — poll at a fixed, short interval. Discovery is
   *    cheap, and the common cause is that the user has not started a browser
   *    yet, so a long backoff would make them wait a minute after they do.
   *  - **Endpoint found but the connection failed** — exponential backoff, so a
   *    wedged endpoint is not hammered.
   *
   * @param delayMs - explicit delay; omitted selects backoff for a failure.
   */
  #scheduleReconnect(delayMs) {
    if (this.#reconnectTimer !== null) return
    const delay = delayMs ?? this.#reconnectDelay
    if (delayMs === undefined) {
      this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, RECONNECT_MAX_MS)
    }
    this.#reconnectTimer = setTimeout(async () => {
      this.#reconnectTimer = null
      await this.connect().catch(() => {})
    }, delay)
    this.#reconnectTimer.unref?.()
  }

  /** Promote a live socket to `connected` and start the keep-alive heartbeat. */
  async #markConnected(connection, browser, port) {
    this.#connection = connection
    this.#browser = browser
    this.#endpoint = `127.0.0.1:${port}`
    this.#state = State.Connected
    this.#connectedAt = Date.now()
    this.#reconnectDelay = RECONNECT_BASE_MS
    this.#awaitingHint = null
    this.#lastError = null
    connection.on('close', () => {
      if (this.#state === State.Connected) {
        this.#state = State.Disconnected
        this.#connectedAt = null
        this.#scheduleReconnect()
      }
    })
    clearInterval(this.#heartbeatTimer)
    this.#heartbeatTimer = setInterval(() => {
      this.#heartbeat().catch(() => {})
    }, this.#config.heartbeatMs)
    this.#heartbeatTimer.unref?.()
    await this.#heartbeat().catch(() => {})
  }

  /** Keep-alive: also refreshes the page count shown by the panel. */
  async #heartbeat() {
    const connection = this.#connection
    if (connection === null || !connection.connected) return
    const { targetInfos } = await connection.send('Target.getTargets')
    this.#lastHeartbeatAt = Date.now()
    this.#pageCount = targetInfos.filter((t) => t.type === 'page').length
  }

  /**
   * Ensure a live connection, connecting on demand.
   * @returns the active connection.
   * @throws when the browser cannot be reached or is awaiting approval.
   */
  async require() {
    // Never re-discover while a prompt is pending: see connect().
    if (this.#state !== State.Connected && this.#state !== State.AwaitingApproval) {
      await this.connect()
    }
    if (this.#state === State.AwaitingApproval) {
      throw new CdpError(this.#awaitingHint ?? 'awaiting approval', FailureKind.AwaitingApproval)
    }
    if (this.#state !== State.Connected || this.#connection === null) {
      throw new CdpError(this.#lastError ?? 'not connected to a browser', FailureKind.Unreachable)
    }
    return this.#connection
  }

  async disconnect() {
    clearInterval(this.#heartbeatTimer)
    clearTimeout(this.#reconnectTimer)
    this.#heartbeatTimer = null
    this.#reconnectTimer = null
    this.#connection?.close()
    this.#connection = null
    this.#state = State.Disconnected
    this.#connectedAt = null
    this.#endpoint = null
    this.#pageCount = 0
  }

  async dispose() {
    await this.disconnect()
    this.#activeDepth = 0
    this.#activeUntil = null
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Resolve a page target by id, falling back to the first page. */
async function resolveTarget(connection, targetId) {
  const { targetInfos } = await connection.send('Target.getTargets')
  const pages = targetInfos.filter((t) => t.type === 'page')
  if (targetId !== undefined) {
    const hit = pages.find((t) => t.targetId === targetId)
    if (hit === undefined) throw new CdpError(`no page target ${targetId}`, FailureKind.Protocol)
    return hit
  }
  if (pages.length === 0) throw new CdpError('no open page', FailureKind.Protocol)
  return pages[0]
}

/**
 * Run one command against the live connection.
 *
 * Commands split into two kinds, and the split is load-bearing:
 *
 *   - **Observation** (`status`, `browsers`) never attaches. They read local
 *     state and the filesystem only, so polling the panel or asking for a
 *     launch hint can never raise the browser's approval prompt.
 *   - **Action** (`tabs`, `eval`, …) calls `session.require()`, which performs
 *     the first attach on demand. This is the boundary where the browser is
 *     asked for control, so a prompt appears only once the session genuinely
 *     needs the browser.
 *
 * `connect` is the one explicit exception: it attaches on request, which the
 * panel uses when the user clicks the button themselves.
 *
 * Every command that is not an observation also raises the session's activity
 * flag for the duration plus a hold window, which is what the composer icon
 * reads to show the agent driving the browser. The heartbeat is exempt by
 * construction: it is an internal loop and never passes through here, so a
 * merely-connected plugin does not read as busy.
 */
async function runCommand(session, command, args) {
  // The activity flag is raised around the whole dispatch. It is raised before
  // the work starts so a status poll landing mid-command already sees it, and
  // released in `finally` so a failed command counts too: the agent reached for
  // the browser either way, and the icon reports exactly that.
  //
  // Observation commands are exempt — see OBSERVATION_COMMANDS.
  const tracked = !OBSERVATION_COMMANDS.has(command)
  if (tracked) session.beginActivity()
  try {
    return await executeCommand(session, command, args)
  } finally {
    if (tracked) session.endActivity(Date.now())
  }
}

/** Dispatch one command; `runCommand` owns the activity bookkeeping around it. */
async function executeCommand(session, command, args) {
  const maxBytes = session.maxOutputBytes

  switch (command) {
    case 'status':
      // Observation: reports the state machine without advancing it.
      return { status: session.snapshot() }

    case 'browsers': {
      // Observation: filesystem and TCP probes only — no CDP attach.
      const { browsers } = await discover({
        extraDirs: session.config.extraDirs,
        ports: session.config.ports,
        includeHttp: false,
        explicitDataDir: session.config.dataDir,
      })
      const rows = []
      for (const browser of browsers) {
        const active = await readActivePort(browser.dataDir)
        const listening = active === undefined ? false : await tcpProbe(active.port)
        rows.push({
          id: browser.id,
          name: browser.name,
          dataDir: browser.dataDir,
          hasPortFile: active !== undefined,
          listening,
          port: active?.port ?? null,
          launch: `${browser.exePath} --remote-debugging-port=9222 --user-data-dir="${browser.dataDir}"`,
        })
      }
      return { browsers: rows, current: session.snapshot().browserId }
    }

    case 'tabs': {
      const connection = await session.require()
      const { targetInfos } = await connection.send('Target.getTargets')
      const pages = targetInfos
        .filter((t) => t.type === 'page')
        .map((t) => ({
          id: t.targetId,
          title: clipText(t.title ?? '', 120),
          url: clipText(t.url ?? '', 200),
        }))
      return { pages }
    }

    case 'open': {
      if (typeof args.url !== 'string' || args.url === '') throw new Error('open requires url')
      const connection = await session.require()
      const created = await connection.send('Target.createTarget', { url: 'about:blank' })
      await withPage(connection, created.targetId, async (sessionId) => {
        await navigate(connection, sessionId, args.url, { settleMs: args.settleMs ?? 400 })
      })
      return { id: created.targetId, url: args.url }
    }

    case 'goto': {
      if (typeof args.url !== 'string' || args.url === '') throw new Error('goto requires url')
      const connection = await session.require()
      const target = await resolveTarget(connection, args.tabId)
      await withPage(connection, target.targetId, async (sessionId) => {
        await navigate(connection, sessionId, args.url, { settleMs: args.settleMs ?? 400 })
      })
      return { id: target.targetId, url: args.url }
    }

    case 'close': {
      const connection = await session.require()
      const target = await resolveTarget(connection, args.tabId)
      await connection.send('Target.closeTarget', { targetId: target.targetId })
      return { closed: target.targetId }
    }

    case 'eval': {
      if (typeof args.expression !== 'string' || args.expression === '') {
        throw new Error('eval requires expression')
      }
      const connection = await session.require()
      const target = await resolveTarget(connection, args.tabId)
      return withPage(connection, target.targetId, async (sessionId) => {
        const value = await evaluate(connection, sessionId, args.expression, {
          awaitPromise: args.awaitPromise !== false,
        })
        return { value: clipText(typeof value === 'string' ? value : JSON.stringify(value ?? null), maxBytes) }
      })
    }

    case 'snapshot': {
      const connection = await session.require()
      const target = await resolveTarget(connection, args.tabId)
      return withPage(connection, target.targetId, async (sessionId) => {
        const limit = Math.min(Number(args.limit ?? 80) || 80, SNAPSHOT_NODE_LIMIT)
        const tree = await evaluate(
          connection,
          sessionId,
          `(() => {
             const out = [];
             const walk = (el, depth) => {
               if (out.length >= ${limit} || depth > 8) return;
               const tag = el.tagName.toLowerCase();
               if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
               const id = el.id ? '#' + el.id : '';
               const cls = el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '';
               const text = el.children.length === 0 ? (el.textContent || '').trim().slice(0, 60) : '';
               out.push('  '.repeat(depth) + tag + id + cls + (text ? ' "' + text + '"' : ''));
               for (const child of el.children) walk(child, depth + 1);
             };
             if (document.body) walk(document.body, 0);
             return out.join('\\n');
           })()`,
        )
        const info = await evaluate(
          connection,
          sessionId,
          `({ title: document.title, url: location.href, nodes: document.querySelectorAll('*').length })`,
        )
        return { ...info, truncated: (info?.nodes ?? 0) > limit, tree: clipText(String(tree ?? ''), maxBytes) }
      })
    }

    case 'click': {
      const connection = await session.require()
      const target = await resolveTarget(connection, args.tabId)
      return withPage(connection, target.targetId, async (sessionId) => {
        if (typeof args.selector === 'string' && args.selector !== '') {
          const hit = await evaluate(
            connection,
            sessionId,
            `(() => { const el = document.querySelector(${JSON.stringify(args.selector)});
               if (el === null) return false; el.click(); return true })()`,
          )
          if (hit !== true) throw new Error(`no element matches ${args.selector}`)
          return { clicked: args.selector }
        }
        if (typeof args.x === 'number' && typeof args.y === 'number') {
          await clickAt(connection, sessionId, args.x, args.y)
          return { clicked: `${args.x},${args.y}` }
        }
        throw new Error('click requires selector or x/y')
      })
    }

    case 'type': {
      if (typeof args.text !== 'string') throw new Error('type requires text')
      const connection = await session.require()
      const target = await resolveTarget(connection, args.tabId)
      return withPage(connection, target.targetId, async (sessionId) => {
        if (typeof args.selector === 'string' && args.selector !== '') {
          await evaluate(
            connection,
            sessionId,
            `(() => { const el = document.querySelector(${JSON.stringify(args.selector)});
               if (el === null) return false; el.focus(); return true })()`,
          )
        }
        await typeText(connection, sessionId, args.text)
        return { typed: args.text.length }
      })
    }

    case 'shot': {
      const connection = await session.require()
      const target = await resolveTarget(connection, args.tabId)
      return withPage(connection, target.targetId, async (sessionId) => {
        const png = await screenshot(connection, sessionId, { fullPage: args.fullPage === true })
        const image = decodePng(png)
        const dir = args.out ?? session.shotDir
        await mkdir(dir, { recursive: true })
        const file = join(dir, `dsh-cdp-${Date.now()}.png`)
        await writeFile(file, png)
        return { path: file, width: image.width, height: image.height, bytes: png.length }
      })
    }

    case 'assert': {
      if (!Array.isArray(args.checks) || args.checks.length === 0) {
        throw new Error('assert requires a non-empty checks array')
      }
      const connection = await session.require()
      const target = await resolveTarget(connection, args.tabId)
      return withPage(connection, target.targetId, async (sessionId) => {
        const results = await runChecks(connection, sessionId, args.checks)
        return {
          passed: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          total: results.length,
          results,
        }
      })
    }

    case 'console':
    case 'network':
      // Ring buffers require subscribing at attach time; not implemented.
      return { entries: [], note: `${command} capture is not implemented` }

    case 'connect':
      // The explicit attach, used when the user asks for one. It is the same
      // path a first real command takes; it exists separately so the panel can
      // offer a button that starts with a click rather than a tool call.
      await session.connect()
      return { status: session.snapshot() }

    case 'reconnect':
      await session.disconnect()
      await session.connect()
      return { status: session.snapshot() }

    case 'stop':
      await session.disconnect()
      return { status: session.snapshot() }


    default:
      throw new Error(`unknown command "${command}"`)
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * The skill body lives in `skill.md` next to this file and is read at plugin
 * init, so the prose is edited as Markdown with no escaping and no template
 * literal in the way. The only substitution is the route path, written as
 * `{{routePath}}` in the Markdown, with a check that a configured routePath
 * actually reaches the body. `skill.md` ships because `lib` is in the package
 * `files` list.
 */
const SKILL_DESCRIPTION =
  'Drive a Chromium browser on this machine (Chrome, Edge, Brave, Vivaldi, Opera, Chromium) over CDP: navigate, evaluate JS, snapshot the DOM, click, type, screenshot, and run pixel/DOM assertions.'

const SKILL_FILE = fileURLToPath(new URL('./skill.md', import.meta.url))
const ROUTE_PLACEHOLDER = '{{routePath}}'

function skillBody(routePath) {
  let template
  try {
    template = readFileSync(SKILL_FILE, 'utf8')
  } catch (error) {
    throw new Error(`dsh-cdp: cannot read the bundled skill at ${SKILL_FILE} — ${error.message}`)
  }
  if (template.trim() === '') throw new Error(`dsh-cdp: the bundled skill at ${SKILL_FILE} is empty`)
  return template.replaceAll(ROUTE_PLACEHOLDER, routePath)
}

/**
 * Wire the plugin: one browser session, one route, one skill.
 */
export function apply(ctx, config = {}) {
  const settings = { ...Defaults, ...config }
  const routePath = settings.routePath

  // Everything the session needs arrives through the constructor; nothing is
  // patched on afterwards, so an omitted field cannot silently lose its value.
  const session = new BrowserSession(ctx, settings)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: routePath,
        handler: async (req, res) => {
          try {
            if (!isLocalHost(req)) {
              return sendJson(res, 403, { ok: false, error: 'forbidden', message: 'loopback access only' })
            }

            // `cmd` may arrive in the query string (the documented calling
            // convention) or in a JSON body; the query wins when both are set.
            const url = new URL(req.url ?? routePath, 'http://127.0.0.1')
            let command = url.searchParams.get('cmd') ?? ''
            let args = {}
            if (req.method !== 'GET') {
              const body = await readBody(req)
              args = body
              if (command === '' && typeof body.cmd === 'string') command = body.cmd
            }
            if (command === '') command = 'status'

            const result = await session.serialize(() => runCommand(session, command, args))
            return sendJson(res, 200, { ok: true, ...result })
          } catch (error) {
            const kind = error instanceof CdpError ? error.kind : undefined
            const message = error instanceof Error ? error.message : String(error)
            const status = kind === FailureKind.AwaitingApproval ? 409 : 200
            if (kind !== FailureKind.AwaitingApproval) {
              ctx.logger?.warn?.(`dsh-cdp: ${message}`)
            }
            return sendJson(res, status, {
              ok: false,
              error: kind ?? 'command-failed',
              message,
              status: session.snapshot(),
            })
          }
        },
      }),
    'dsh-cdp: route',
  )

  // Register the usage skill from code so no file install step exists.
  //
  // `source` is required even though `register()` does not demand it: the
  // registry validates a runtime contribution with `validateRuntimeSkill`
  // (name/description/invocation only) but validates the *loaded* definition
  // with `validateDefinition`, which requires a string `source`. Omitting it
  // lets the skill register and appear in the catalog, then fails at the moment
  // the model actually loads it. `provider` is genuinely optional — `register()`
  // defaults it to the runtime provider.
  ctx.inject(['skills'], (skillCtx) => {
    ctx.effect(
      () =>
        skillCtx.skills.register({
          name: 'browser-cdp',
          description: SKILL_DESCRIPTION,
          whenToUse:
            'Use when the task needs a real browser: checking a running web app, DOM or pixel assertions, reading page state, or driving a page the user already has open.',
          content: skillBody(routePath),
          source: 'runtime',
          invocation: { modelInvocable: true, userInvocable: true },
        }),
      'dsh-cdp: skill',
    )
  })

  // Off by default: attaching at load would raise the browser's remote
  // debugging prompt on GUI startup, for a capability the session may never
  // use. See the `autoConnect` default for the reasoning.
  if (settings.autoConnect === true) {
    session.connect().catch((error) => {
      ctx.logger?.warn?.(`dsh-cdp: initial connect failed — ${error?.message ?? error}`)
    })
  }

  ctx.effect(() => () => session.dispose(), 'dsh-cdp: session')
}

export { State, BrowserSession, runCommand }
