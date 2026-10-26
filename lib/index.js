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
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CdpConnection,
  CdpError,
  FailureKind,
  PageSessions,
  ariaSnapshot,
  bringToFront,
  clickAt,
  clickSelector,
  decodePng,
  dispatchPoint,
  dragBetween,
  emulateMedia,
  evaluate,
  evaluateDescribed,
  hoverAt,
  modifierMask,
  navigate,
  navigateHistory,
  pressKey,
  resizeViewport,
  runChecks,
  screenshot,
  selectOption,
  setFileInput,
  typeText,
  WAIT_BUDGET_MS,
  waitFor,
  wheelAt,
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
/**
 * Deadline for the CDP WebSocket handshake.
 *
 * Generous on purpose. On a loopback endpoint the handshake normally lands in
 * 1–2s, but Chromium has been observed to stall it past 4s and occasionally to
 * abandon it outright, so a short deadline misreads "slow" as "waiting for
 * approval" and parks a socket the browser is about to open. The only cost of
 * waiting longer is paid by a genuinely dead endpoint, which reports an error
 * instead of silence and is therefore handled separately.
 */
const OPEN_TIMEOUT_MS = 12_000
const CALL_TIMEOUT_MS = 10_000
/**
 * How long the approval watch may keep a silent socket parked.
 *
 * Past this budget the connection is more likely wedged than pending, and a
 * parked socket nothing can leave is worse than a reconnect that raises one
 * fresh prompt.
 */
const APPROVAL_GIVE_UP_MS = 90_000
/** Approval watch cadence. */
const APPROVAL_POLL_MS = 2_000
/** Deadline for one adoption poll inside the watch, kept under the cadence. */
const APPROVAL_POLL_TIMEOUT_MS = 1_200
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
 * Cap on assertions in one `assert` call.
 *
 * Each check is at least one protocol round trip, and a click-carrying check
 * also waits. The route has no cancellation, so an unbounded list would let a
 * single call hold the browser and the serialisation queue indefinitely.
 */
const MAX_CHECKS = 50

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
  /**
   * Write commands (`goto`, `click`, `type`, `close`, `assert` with clicks)
   * must target a tab this session opened via `open`. Enforced in code, not
   * left to the skill's prose: without it, an agent that omits `tabId` drives
   * whatever page the browser reports first — normally the user's. Set to
   * `false` to restore the old first-page fallback.
   */
  strictTabs: true,
  /**
   * Directories `upload` may read files from.
   *
   * Empty by default, which disables the command. The plugin runs in the host
   * process, outside the agent's file sandbox, so an unconstrained upload path
   * makes `upload` + `eval` an arbitrary file read: attach any file to a file
   * input, then read it back with page script. The boundary is configured by
   * the host rather than chosen per request, the same way `shotDir` decides
   * where screenshots may be written.
   */
  uploadRoots: [],
  /** Append one JSONL line per browser command to the audit trail. */
  audit: true,
  /** Directory the audit trail is written to; defaults under the OS temp dir. */
  auditDir: undefined,
  /**
   * How a JavaScript dialog on a tab **this session opened** is answered.
   *
   * `dismiss` is the default because a dialog blocks the page: while it is
   * open, every protocol call to that tab waits for a reply that cannot come,
   * so each one burns its full timeout and the page looks hung. Answering is
   * the difference between "the confirm() was declined, carry on" and "the tab
   * is stuck".
   *
   * Dialogs on tabs the session did **not** open are recorded but never
   * answered. Clicking OK on someone's unsaved-work prompt from inside a plugin
   * is a write to their session, and the tab-ownership rule exists to keep that
   * boundary: the agent reads the dialog list and asks the user instead.
   */
  dialogPolicy: 'dismiss',
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

/**
 * What the approval watch should do after one adoption poll.
 *
 * Kept pure so the load-bearing decision is testable without timers or a
 * browser. A parked socket has exactly three futures, and conflating them is
 * how a plugin ends up stuck on `awaiting-approval` forever:
 *
 *   - it opened → promote it;
 *   - the socket died (`error`/`close`) → it can never open, so reconnect;
 *   - it went quiet past the give-up budget → a real prompt does not wait this
 *     long, so the socket is wedged; reconnect rather than stay parked.
 *
 * @param outcome - `null` when the socket opened, otherwise the failure kind
 * @param parkedForMs - how long this socket has been parked
 * @param giveUpMs - the give-up budget
 * @returns `'promote' | 'wait' | 'recover'`
 */
function approvalWatchStep(outcome, parkedForMs, giveUpMs) {
  if (outcome === null) return 'promote'
  if (outcome !== FailureKind.AwaitingApproval) return 'recover'
  return parkedForMs >= giveUpMs ? 'recover' : 'wait'
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
  /** When the current parked socket was first classified as awaiting approval. */
  #approvalParkedAt = null
  #heartbeatTimer = null
  #reconnectTimer = null
  #reconnectDelay = RECONNECT_BASE_MS
  #connecting = null
  #queue = Promise.resolve()
  #pageCount = 0
  /**
   * Tabs this session opened via `open` — the only targets write commands may
   * act on while `strictTabs` is on (see Defaults). Cleared on disconnect: the
   * tabs themselves may survive a dropped connection, but ownership is a fact
   * about *this* connection's history, and a stale grant would outlive the
   * trust it was based on.
   */
  #ownedTabs = new Set()
  /** Resolved audit directory; created lazily on the first audited command. */
  #auditDir = null
  /** Persistent per-page sessions: the reason console/network survive a command. */
  #pages = null
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

    // Discovery touches the filesystem and opens TCP probes across every known
    // profile, so it can fail (a permission error on one profile directory)
    // rather than report "nothing found". Left unhandled, that rejection would
    // escape the reconnect timer with the state stuck on `connecting`: every
    // later `require()` would return immediately and report "not connected to
    // a browser" forever, because `connect()` returns early on that state.
    let candidates
    try {
      ;({ candidates } = await discover({
        extraDirs: this.#config.extraDirs,
        ports: this.#config.ports,
        includeHttp: true,
        explicitDataDir: this.#config.dataDir,
      }))
    } catch (error) {
      this.#state = State.Error
      this.#browser = null
      this.#endpoint = null
      this.#lastError = `browser discovery failed: ${error instanceof Error ? error.message : String(error)}`
      this.#scheduleReconnect()
      return
    }

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
          this.#park(connection, candidate)
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
   * Park a socket on the browser's approval prompt.
   *
   * A handshake that timed out is ambiguous: the browser may be showing a
   * prompt (silence is expected while it waits), or the connection may be
   * wedged. Parking keeps the first case workable — the user's pending choice
   * survives — while the watch below bounds the second.
   */
  #park(connection, candidate) {
    this.#connection = connection
    this.#state = State.AwaitingApproval
    this.#browser = candidate.browser
    this.#endpoint = `127.0.0.1:${candidate.port}`
    this.#awaitingHint =
      'Waiting for approval — switch to the browser window and click "Allow" on the remote debugging prompt.'
    this.#approvalParkedAt = Date.now()
    this.#scheduleApprovalWatch()
  }

  /**
   * Adopt the parked socket once the browser completes the handshake.
   *
   * The socket the handshake timed out on is still live and still holds the
   * browser's approval prompt, so it is adopted directly. Opening a fresh
   * connection here would raise a *second* prompt and lose the first.
   *
   * Three outcomes end the watch, and only the first is a success:
   *
   *   - **it opens** — approval was granted; promote to `connected`;
   *   - **it errors or closes** — the socket is dead, so waiting on it can
   *     never succeed; drop it and go back through the ordinary reconnect path;
   *   - **the give-up budget elapses** — still silent, but past the point where
   *     a real prompt is plausible. Reconnecting costs one fresh prompt, which
   *     is strictly better than a state nothing can leave.
   */
  #scheduleApprovalWatch() {
    const connection = this.#connection
    if (connection === null) return
    clearInterval(this.#heartbeatTimer)
    // The watch owns its handle. Reaching for `this.#heartbeatTimer` from inside
    // a tick would act on whatever timer is installed *now* — and after a second
    // park that is a different watch, which the old tick would then clear.
    const timer = setInterval(async () => {
      if (this.#state !== State.AwaitingApproval) {
        clearInterval(timer)
        return
      }
      let failure
      try {
        await connection.waitForOpen({ timeoutMs: APPROVAL_POLL_TIMEOUT_MS })
      } catch (error) {
        failure = error
      }
      // The session may have been stopped, disconnected, or replaced while this
      // poll was in flight. Promoting then would install a socket the owner has
      // already let go of — and nothing would ever close it.
      if (this.#connection !== connection) {
        clearInterval(timer)
        return
      }
      const outcome =
        failure === undefined
          ? null
          : failure instanceof CdpError
            ? failure.kind
            : FailureKind.Unreachable
      const parkedForMs = this.#approvalParkedAt === null ? 0 : Date.now() - this.#approvalParkedAt
      const step = approvalWatchStep(outcome, parkedForMs, APPROVAL_GIVE_UP_MS)

      if (step === 'wait') return
      if (step === 'recover') {
        this.#giveUpOnParkedSocket(connection)
        return
      }

      clearInterval(timer)
      // The browser completed the handshake: approval was granted.
      const parts = (this.#endpoint ?? '').split(':')
      try {
        await this.#markConnected(
          connection,
          this.#browser ?? { id: 'unknown', name: 'Chromium browser' },
          Number(parts[1] ?? 9222),
        )
      } catch {
        // A fault inside promotion must not surface as an unhandled rejection
        // from a timer: fall back to the ordinary reconnect path.
        this.#state = State.Error
        connection.close()
        this.#scheduleReconnect()
      }
    }, APPROVAL_POLL_MS)
    this.#heartbeatTimer = timer
    timer.unref?.()
  }

  /** Abandon a parked socket that will never open, and re-enter the normal path. */
  #giveUpOnParkedSocket(connection) {
    // The watch can fire while a promotion is already in flight: the socket is
    // then live and owned by the session, so closing it here would kill a
    // connection that just succeeded. Only a socket this session still holds as
    // parked may be abandoned.
    if (this.#state !== State.AwaitingApproval || this.#connection !== connection) {
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = null
      return
    }
    clearInterval(this.#heartbeatTimer)
    this.#heartbeatTimer = null
    this.#connection = null
    this.#approvalParkedAt = null
    this.#awaitingHint = null
    this.#state = State.Error
    this.#lastError = 'the parked handshake never completed — retrying'
    connection.close()
    // Back off rather than poll fast: the endpoint answered discovery, so the
    // browser exists — what failed is the attach, and hammering it would raise
    // a fresh approval prompt per attempt.
    this.#scheduleReconnect()
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
   * A fixed-interval schedule also repairs the backoff: without that reset, a
   * browser that wedged the endpoint once left every later retry — including
   * the ones that found nothing at all — on the long cadence, so a browser
   * started a minute later took a minute to be noticed.
   *
   * @param delayMs - explicit delay; omitted selects backoff for a failure.
   */
  #scheduleReconnect(delayMs) {
    if (this.#reconnectTimer !== null) return
    let delay
    if (delayMs === undefined) {
      delay = this.#reconnectDelay
      this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, RECONNECT_MAX_MS)
    } else {
      delay = delayMs
      this.#reconnectDelay = RECONNECT_BASE_MS
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
    this.#approvalParkedAt = null
    this.#lastError = null
    // Socket-level loss, not a CDP protocol event: the protocol has no
    // "close" event, so this must ride the transport callback or the state
    // machine would sit on `connected` forever after the browser went away.
    //
    // The identity check matters: a `reconnect` closes the old socket and
    // opens a new one, but the old socket's `close` event arrives
    // asynchronously — possibly after the new connection is already live and
    // the state is `Connected` again. Without the check that late event would
    // mark the live connection dead and raise a duplicate attach.
    connection.onClose(() => {
      if (this.#connection !== connection) return
      // The sessions belonged to a socket that no longer exists: their captures
      // are dead and their listeners would never fire again. Dropping the set
      // makes the next command attach fresh sessions instead of writing into a
      // buffer nothing feeds.
      const pages = this.#pages
      this.#pages = null
      pages?.dispose()
      if (this.#state === State.Connected) {
        this.#state = State.Disconnected
        this.#connectedAt = null
        this.#scheduleReconnect()
      }
    })
    clearInterval(this.#heartbeatTimer)
    // The loop belongs to this socket: after a reconnect the old interval's
    // in-flight call can still resolve, and writing its reply into the fields
    // would report the dead socket's page count and heartbeat as the live one's.
    const timer = setInterval(() => {
      this.#heartbeat(connection).catch(() => {})
    }, this.#config.heartbeatMs)
    this.#heartbeatTimer = timer
    timer.unref?.()
    await this.#heartbeat(connection).catch(() => {})
  }

  /** Keep-alive: also refreshes the page count shown by the panel. */
  async #heartbeat(connection) {
    if (connection === null || connection !== this.#connection || !connection.connected) return
    const { targetInfos } = await connection.send('Target.getTargets')
    // Re-checked after the await: a reconnect during the round trip makes this
    // reply stale, and the new socket is the one that owns the fields.
    if (connection !== this.#connection) return
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

  /** Register a tab as opened by this session (the `open` command). */
  ownTab(targetId) {
    this.#ownedTabs.add(targetId)
  }

  /**
   * The page-session set for the live connection, attaching on demand.
   *
   * Sessions are made here rather than per command because their whole value is
   * that they outlive the command that first touched the page. The dialog policy
   * is resolved per tab: an owned tab gets its dialogs answered, a tab the agent
   * does not own only gets them recorded — see `Defaults.dialogPolicy`.
   */
  pages() {
    if (this.#pages !== null) return this.#pages
    const connection = this.#connection
    if (connection === null) throw new CdpError('not connected to a browser', FailureKind.Unreachable)
    this.#pages = new PageSessions(connection, {
      dialogPolicy: this.#config.dialogPolicy ?? Defaults.dialogPolicy,
      dialogPolicyFor: (targetId) => {
        // A tab the session did not open belongs to the user: record the
        // dialog, never answer it on their behalf.
        const policy = this.#config.dialogPolicy ?? Defaults.dialogPolicy
        if (policy === 'ignore') return 'ignore'
        return this.#ownedTabs.has(targetId) ? policy : 'ignore'
      },
    })
    return this.#pages
  }

  /** Attach (or reuse) the session for one page target. */
  async page(targetId) {
    await this.require()
    return this.pages().acquire(targetId)
  }

  /** Drop a target's session (the target is gone, or the tab was closed). */
  dropPage(targetId) {
    this.#pages?.forget(targetId)
  }

  /** Drop a tab's ownership (the `close` command). */
  forgetTab(targetId) {
    this.#ownedTabs.delete(targetId)
  }

  /** Whether a tab was opened by this session and may receive writes. */
  ownsTab(targetId) {
    return this.#ownedTabs.has(targetId)
  }

  /**
   * Append one line to the audit trail.
   *
   * Deliberately records the command name, target tab, and outcome — never
   * the arguments. Expressions can be large and carry page content the user
   * did not agree to persist; the trace answers "what did the agent do to
   * which tab and did it fail", which is all an after-the-fact review needs.
   */
  async audit(entry) {
    if (this.#config.audit === false) return
    if (this.#auditDir === null) {
      this.#auditDir = this.#config.auditDir ?? join(tmpdir(), 'dsh-cdp-audit')
    }
    const day = new Date().toISOString().slice(0, 10)
    await mkdir(this.#auditDir, { recursive: true })
    await appendFile(join(this.#auditDir, `audit-${day}.jsonl`), `${JSON.stringify(entry)}\n`)
  }

  async disconnect() {
    clearInterval(this.#heartbeatTimer)
    clearTimeout(this.#reconnectTimer)
    this.#heartbeatTimer = null
    this.#reconnectTimer = null
    // Detach the page sessions before the socket goes: their listeners live on
    // the connection, and a closed socket turns every detach into a failed call.
    const pages = this.#pages
    this.#pages = null
    if (pages !== null) {
      await pages.closeAll().catch(() => {})
      pages.dispose()
    }
    this.#connection?.close()
    this.#connection = null
    this.#state = State.Disconnected
    this.#connectedAt = null
    this.#endpoint = null
    this.#pageCount = 0
    this.#approvalParkedAt = null
    this.#awaitingHint = null
    this.#ownedTabs.clear()
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
 * Resolve the directory a `shot` writes to.
 *
 * `out` arrives from the HTTP body and the plugin runs in the host process,
 * outside the agent sandbox — so it is accepted only as a path *relative to
 * the configured screenshot directory*, and anything that escapes it (an
 * absolute path, `..`) is refused. The host configured `shotDir`; a request
 * does not get to choose where the host writes.
 */
function resolveShotDir(session, out) {
  const base = resolve(session.shotDir)
  if (out === undefined || out === null || out === '') return base
  if (typeof out !== 'string') {
    throw new CdpError('out must be a directory path relative to the screenshot dir', FailureKind.Protocol)
  }
  const target = resolve(base, out)
  const rel = relative(base, target)
  // '' means `out` pointed at the base itself (`out: "."`) — same as omitting it.
  if (rel === '') return target
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new CdpError(
      `out "${out}" escapes the screenshot dir (${base}) — pass a relative directory only`,
      FailureKind.Protocol,
    )
  }
  return target
}

/**
 * Resolve an upload path against the allowed roots.
 *
 * `shot` already confines where the host writes; upload is the same boundary in
 * the reading direction and needs the same guard, because this plugin runs in
 * the host process — outside the agent's file sandbox. Without it, `upload` plus
 * `eval` is arbitrary file read: point a file input at any path, then read it
 * back through the page.
 *
 * A path is accepted only when it is absolute, has no `..` segment, and resolves
 * inside one of `uploadRoots`. Relative paths are refused rather than resolved
 * against the host's cwd, which is a property of the server and not something a
 * request should be able to depend on.
 */
function resolveUploadPath(session, file) {
  if (typeof file !== 'string' || file === '') {
    throw new CdpError('upload files must be non-empty path strings', FailureKind.Protocol)
  }
  // UNC shares and the `\\?\` device prefix reach outside any ordinary root and
  // are not subject to the containment check below in the way a drive path is.
  if (file.startsWith('\\\\')) {
    throw new CdpError(`upload path "${file}" is a UNC or device path — local drive paths only`, FailureKind.Protocol)
  }
  if (!isAbsolute(file)) {
    throw new CdpError(`upload path "${file}" must be absolute — relative paths have no defined base here`, FailureKind.Protocol)
  }
  const target = resolve(file)
  // An empty or non-string entry would resolve to the host's working directory
  // (or throw a TypeError on every request): both turn a configuration mistake
  // into a silent widening of the boundary or an opaque failure.
  const configured = Array.isArray(session.config.uploadRoots) ? session.config.uploadRoots : []
  const roots = configured
    .filter((root) => typeof root === 'string' && root.trim() !== '' && isAbsolute(root))
    .map((root) => resolve(root))
  if (roots.length === 0) {
    throw new CdpError(
      configured.length === 0
        ? 'upload is disabled: no uploadRoots configured — set uploadRoots on the plugin to the directories files may come from'
        : `upload is disabled: every configured uploadRoots entry is unusable (${configured.map((r) => String(r)).join(', ')}) — each must be a non-empty absolute path`,
      FailureKind.Protocol,
    )
  }
  for (const root of roots) {
    const rel = relative(root, target)
    // '' means the target IS the root, which is a directory rather than a file.
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue
    return target
  }
  throw new CdpError(
    `upload path "${file}" is outside every allowed upload root (${roots.join(', ')})`,
    FailureKind.Protocol,
  )
}

/**
 * Write-command guard: writes must land on a tab this session opened.
 *
 * The skill used to state this as a rule for the model to keep; now it is a
 * precondition the code checks. `eval` is deliberately outside the guard —
 * no read/write distinction exists for an expression, so guarding it would
 * be security theatre, and the skill says to keep `eval` side-effect free on
 * tabs you did not open.
 */
function checkWriteTab(session, command, args) {
  if (session.config.strictTabs === false) return
  const tabId = args?.tabId
  if (typeof tabId !== 'string' || tabId === '') {
    throw new CdpError(
      `${command} requires the tabId of a tab you opened with cmd=open (omitting it is not a fallback)`,
      FailureKind.Protocol,
    )
  }
  if (!session.ownsTab(tabId)) {
    throw new CdpError(
      `${command} refused: tab ${tabId} was not opened by this session — open your own tab (cmd=open) and act there`,
      FailureKind.Protocol,
    )
  }
}

/**
 * Resolve a target, attach its session, and run `fn` with it.
 *
 * Every page-scoped command goes through this. The session is *reused* rather
 * than detached afterwards: that is what keeps its console/network captures
 * alive between commands, and it is also why `bringToFront` only has to run
 * once per tab.
 */
async function withSession(session, args, fn, { front = false } = {}) {
  const connection = await session.require()
  const target = await resolveTarget(connection, args?.tabId)
  const pageSession = await session.page(target.targetId)
  if (front) await bringToFront(connection, pageSession.sessionId).catch(() => {})
  return fn(pageSession, target)
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
  // Observation commands are exempt — see OBSERVATION_COMMANDS. The same
  // exemption keeps them out of the audit trail: the panel polls `status`
  // continuously, and a per-poll line would bury the commands worth reviewing.
  const tracked = !OBSERVATION_COMMANDS.has(command)
  if (tracked) session.beginActivity()
  const startedAt = Date.now()
  let ok = false
  let failure = null
  try {
    const result = await executeCommand(session, command, args)
    ok = true
    return result
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    if (tracked) {
      session.endActivity(Date.now())
      await session
        .audit({ ts: new Date(startedAt).toISOString(), cmd: command, tabId: args?.tabId ?? null, ok, error: failure, ms: Date.now() - startedAt })
        .catch(() => {})
    }
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
          // Which of these tabs this session opened — the ones writes may target.
          owned: session.ownsTab(t.targetId),
        }))
      return { pages }
    }

    case 'open': {
      if (typeof args.url !== 'string' || args.url === '') throw new Error('open requires url')
      const connection = await session.require()
      const created = await connection.send('Target.createTarget', { url: 'about:blank' })
      session.ownTab(created.targetId)
      try {
        const pageSession = await session.page(created.targetId)
        await bringToFront(connection, pageSession.sessionId).catch(() => {})
        await navigate(connection, pageSession.sessionId, args.url, { settleMs: args.settleMs ?? 400 })
      } catch (error) {
        // A failed navigation must not leave the tab behind. Closing is what
        // removes it, so ownership is kept until the close has actually
        // succeeded: dropping it first left a tab that is still open but can no
        // longer be closed — `close` would refuse it as not owned. On failure
        // the error still names the id, so the agent can retry `cmd=close`.
        session.dropPage(created.targetId)
        const closed = await connection.send('Target.closeTarget', { targetId: created.targetId }).then(
          () => true,
          () => false,
        )
        if (!closed) {
          const message = error instanceof Error ? error.message : String(error)
          throw new CdpError(
            `open failed (${message}) and the tab ${created.targetId} could not be closed — retry with cmd=close and that tabId`,
            FailureKind.Protocol,
          )
        }
        session.forgetTab(created.targetId)
        throw error
      }
      return { id: created.targetId, url: args.url }
    }

    case 'goto': {
      if (typeof args.url !== 'string' || args.url === '') throw new Error('goto requires url')
      checkWriteTab(session, 'goto', args)
      return withSession(session, args, async (pageSession, target) => {
        await navigate(pageSession.connection, pageSession.sessionId, args.url, { settleMs: args.settleMs ?? 400 })
        return { id: target.targetId, url: args.url }
      })
    }

    case 'back':
    case 'forward': {
      checkWriteTab(session, command, args)
      const delta = command === 'back' ? -1 : 1
      return withSession(session, args, async (pageSession, target) => {
        const result = await navigateHistory(pageSession.connection, pageSession.sessionId, delta)
        return { id: target.targetId, url: result.url }
      })
    }

    case 'close': {
      checkWriteTab(session, 'close', args)
      const connection = await session.require()
      const target = await resolveTarget(connection, args.tabId)
      session.dropPage(target.targetId)
      await connection.send('Target.closeTarget', { targetId: target.targetId })
      session.forgetTab(target.targetId)
      return { closed: target.targetId }
    }

    case 'activate': {
      // Raising a tab is not a write to its content, so any tab may be raised —
      // an agent reading a user's page still needs it rendering, because a
      // background tab's rAF and timers are throttled and its frames go stale.
      return withSession(session, args, async (pageSession, target) => {
        await bringToFront(pageSession.connection, pageSession.sessionId)
        return { active: target.targetId, url: clipText(target.url ?? '', 200) }
      })
    }

    case 'eval': {
      if (typeof args.expression !== 'string' || args.expression === '') {
        throw new Error('eval requires expression')
      }
      return withSession(session, args, async (pageSession) => {
        const described = await evaluateDescribed(pageSession.connection, pageSession.sessionId, args.expression, {
          awaitPromise: args.awaitPromise !== false,
        })
        // A value that has no JSON form is reported as such rather than as
        // `null`: "the page returned NaN" and "the page returned null" are
        // different facts, and only one of them is a bug in the page.
        if (described.kind === 'unserializable') {
          return {
            value: String(described.value),
            kind: 'unserializable',
            ...(described.description === null ? {} : { description: described.description }),
          }
        }
        if (described.kind === 'object') {
          return {
            value: described.description === null ? '[object]' : `[${described.description}]`,
            kind: 'object',
            subtype: described.subtype,
          }
        }
        let text
        if (typeof described.value === 'string') text = described.value
        else {
          try {
            text = JSON.stringify(described.value ?? null)
          } catch {
            text = String(described.value)
          }
        }
        return { value: clipText(text ?? 'null', maxBytes), kind: 'value' }
      })
    }

    case 'snapshot': {
      return withSession(session, args, async (pageSession) => {
        // `aria` switches to the accessibility tree, which is the mode that
        // yields `ref` handles: a role/name pair plus a protocol-resolvable
        // node id. The DOM outline stays the default because it is cheaper and
        // layout-shaped, which suits "what is on this page" better.
        if (args.aria === true) {
          const limit = Math.min(Number(args.limit ?? 120) || 120, SNAPSHOT_NODE_LIMIT)
          const snap = await ariaSnapshot(pageSession, { limit, withBoxes: args.boxes === true })
          return { ...snap, mode: 'aria', tree: clipText(snap.tree, maxBytes) }
        }
        const limit = Math.min(Number(args.limit ?? 80) || 80, SNAPSHOT_NODE_LIMIT)
        const tree = await evaluate(
          pageSession.connection,
          pageSession.sessionId,
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
          pageSession.connection,
          pageSession.sessionId,
          `({ title: document.title, url: location.href, nodes: document.querySelectorAll('*').length })`,
        )
        return { ...info, mode: 'dom', truncated: (info?.nodes ?? 0) > limit, tree: clipText(String(tree ?? ''), maxBytes) }
      })
    }

    case 'click': {
      checkWriteTab(session, 'click', args)
      // Naming the target twice is ambiguous, and silently preferring one is
      // how an agent ends up clicking the wrong thing while its report looks
      // right. Refuse the combination instead of guessing.
      const named = [
        typeof args.ref === 'string' && args.ref !== '',
        typeof args.selector === 'string' && args.selector !== '',
        typeof args.x === 'number' && typeof args.y === 'number',
      ].filter(Boolean).length
      if (named > 1) throw new Error('click takes exactly one target: ref, selector, or x+y (not a combination)')
      const clickOptions = {
        button: typeof args.button === 'string' ? args.button : 'left',
        clickCount: args.doubleClick === true ? 2 : Math.max(1, Number(args.clickCount ?? 1) || 1),
        modifiers: modifierMask(args.modifiers),
      }
      return withSession(session, args, async (pageSession) => {
        const { connection: c, sessionId } = pageSession
        if (typeof args.ref === 'string' && args.ref !== '') {
          const point = await pageSession.pointFor({ ref: args.ref })
          return dispatchPoint(c, sessionId, point, {
            ...clickOptions,
            domClick: async () => {
              await pageSession.withRefObject(args.ref, (objectId) =>
                pageSession.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function () { this.click() }' }),
              )
            },
          }, `ref=${args.ref}`)
        }
        if (typeof args.selector === 'string' && args.selector !== '') {
          return clickSelector(c, sessionId, args.selector, clickOptions)
        }
        if (typeof args.x === 'number' && typeof args.y === 'number') {
          await clickAt(c, sessionId, args.x, args.y, clickOptions)
          return { clicked: `${args.x},${args.y}`, ...clickOptions }
        }
        throw new Error('click requires selector, ref, or x/y')
      })
    }

    case 'hover': {
      // Hovering opens menus and tooltips on the user's own tab. It changes
      // nothing in the page's data, but it does change what they see, and the
      // ownership rule is about not disturbing their session — so it is a write.
      checkWriteTab(session, 'hover', args)
      const byPoint = typeof args.x === 'number' && typeof args.y === 'number'
      const byName = (typeof args.ref === 'string' && args.ref !== '') || (typeof args.selector === 'string' && args.selector !== '')
      if (byPoint && byName) throw new Error('hover takes either x+y or ref/selector, not both')
      return withSession(session, args, async (pageSession) => {
        if (byPoint) {
          await hoverAt(pageSession.connection, pageSession.sessionId, args.x, args.y)
          return { hovered: `${args.x},${args.y}` }
        }
        const point = await pageSession.pointFor({ ref: args.ref, selector: args.selector })
        return dispatchPoint(pageSession.connection, pageSession.sessionId, point, { hoverOnly: true }, args.ref ?? args.selector)
      })
    }

    case 'drag': {
      checkWriteTab(session, 'drag', args)
      // Each endpoint must be named exactly once, for the same reason a click
      // must be: two names for one point is a contradiction, not a preference.
      const endpoint = (label, points, ref, selector) => {
        const byPoint = typeof points[0] === 'number' && typeof points[1] === 'number'
        const byName = (typeof ref === 'string' && ref !== '') || (typeof selector === 'string' && selector !== '')
        if (!byPoint && !byName) {
          throw new Error(`drag needs the ${label} endpoint: ${label}X+${label}Y, ${label}Ref, or ${label}Selector`)
        }
        if (byPoint && byName) throw new Error(`drag ${label} endpoint is named twice — use one of coordinates, ref, or selector`)
        return byPoint
      }
      const fromByPoint = endpoint('from', [args.fromX, args.fromY], args.fromRef, args.fromSelector)
      const toByPoint = endpoint('to', [args.toX, args.toY], args.toRef, args.toSelector)
      return withSession(session, args, async (pageSession) => {
        // Both endpoints are resolved *before* either is used, and the source is
        // re-measured if the target's resolution scrolled the page. `pointFor`
        // scrolls the element into view, so resolving `from` first and `to`
        // second leaves `from`'s viewport coordinates pointing at whatever is
        // now under those pixels — the drag then starts from an unrelated place
        // while reporting success.
        const scrollOf = () =>
          evaluate(pageSession.connection, pageSession.sessionId, `({ x: window.scrollX, y: window.scrollY })`)

        const scrollBefore = await scrollOf()
        const to = toByPoint
          ? { x: args.toX, y: args.toY }
          : await pageSession.pointFor({ ref: args.toRef, selector: args.toSelector })
        const scrollAfterTo = await scrollOf()
        const toScrolled = scrollBefore?.x !== scrollAfterTo?.x || scrollBefore?.y !== scrollAfterTo?.y
        // Re-resolving the source after the target moved the page is what makes
        // its coordinates valid again; `pointFor` scrolls it back into view.
        const from = fromByPoint
          ? { x: args.fromX, y: args.fromY }
          : await pageSession.pointFor({ ref: args.fromRef, selector: args.fromSelector })
        const scrollAfterFrom = await scrollOf()
        if (!fromByPoint && toScrolled && scrollAfterFrom?.y !== scrollAfterTo?.y) {
          // Resolving the source scrolled the page again, which invalidates the
          // target. There is no order that keeps both valid, so say so instead
          // of dragging to a stale point.
          throw new CdpError(
            'drag cannot resolve both endpoints: scrolling to one moves the other. Pass fromX/fromY and toX/toY (or scroll the page yourself first with cmd=wheel)',
            FailureKind.Protocol,
          )
        }
        if (from.dom === true || to.dom === true) {
          throw new CdpError('a drag endpoint has no box (zero width/height) — drag needs visible elements', FailureKind.Protocol)
        }
        await dragBetween(pageSession.connection, pageSession.sessionId, from, to, {
          steps: Number(args.steps ?? 10) || 10,
          modifiers: modifierMask(args.modifiers),
        })
        return { from: { x: Math.round(from.x), y: Math.round(from.y) }, to: { x: Math.round(to.x), y: Math.round(to.y) } }
      })
    }

    case 'wheel': {
      // Scrolling is a write: it moves the page the user is looking at, and a
      // scroll past the fold triggers lazy loading and infinite-scroll requests
      // on their behalf. The tab-ownership rule applies for the same reason it
      // applies to `click`.
      checkWriteTab(session, 'wheel', args)
      const deltaX = Number(args.deltaX ?? 0)
      const deltaY = Number(args.deltaY ?? 0)
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        throw new Error('wheel requires numeric deltaX and deltaY')
      }
      return withSession(session, args, async (pageSession, target) => {
        let x = args.x
        let y = args.y
        if (typeof x !== 'number' || typeof y !== 'number') {
          // Default to scrolling the document through the middle of the
          // viewport, which is where a wheel event would land.
          const size = await evaluate(pageSession.connection, pageSession.sessionId, `({ w: innerWidth, h: innerHeight })`)
          x = Math.round((size?.w ?? 800) / 2)
          y = Math.round((size?.h ?? 600) / 2)
        }
        // `via` is reported because the two paths differ observably: a gesture
        // produces real `wheel` events, the page fallback does not.
        const result = await wheelAt(pageSession.connection, pageSession.sessionId, x, y, deltaX, deltaY)
        return {
          // The values that were applied, not the ones that were sent: a
          // non-numeric delta becomes 0, and echoing the raw string would
          // report a scroll that did not happen.
          scrolled: { x, y, deltaX, deltaY },
          via: result?.via ?? null,
          ...(result?.cancelledByPage === true ? { cancelledByPage: true } : {}),
          id: target.targetId,
        }
      })
    }

    case 'type': {
      if (typeof args.text !== 'string') throw new Error('type requires text')
      checkWriteTab(session, 'type', args)
      return withSession(session, args, async (pageSession) => {
        const { connection: c, sessionId } = pageSession
        // Focusing by selector or ref first, because typing goes to whatever
        // holds focus and a fresh tab's focus is on the body.
        if (typeof args.ref === 'string' && args.ref !== '') {
          await pageSession.withRefObject(args.ref, (objectId) =>
            pageSession.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function () { this.focus() }' }),
          )
        } else if (typeof args.selector === 'string' && args.selector !== '') {
          await evaluate(
            c,
            sessionId,
            `(() => { const el = document.querySelector(${JSON.stringify(args.selector)});
               if (el === null) return false; el.focus(); return true })()`,
          )
        }
        const delayMs = Math.max(0, Number(args.delayMs ?? 0) || 0)
        await typeText(c, sessionId, args.text, { delayMs })
        // `submit` sends Enter after the text, which is what actually submits
        // the form in the common case — clicking a submit button is not always
        // equivalent (some pages only listen for the key).
        if (args.submit === true) {
          await pressKey(c, sessionId, 'Enter')
          return { typed: args.text.length, submitted: true }
        }
        if (args.pressAfter !== undefined && args.pressAfter !== null) {
          await pressKey(c, sessionId, String(args.pressAfter))
          return { typed: args.text.length, pressed: String(args.pressAfter) }
        }
        return { typed: args.text.length }
      })
    }

    case 'key': {
      if (typeof args.key !== 'string' || args.key === '') throw new Error('key requires a key name (e.g. Enter, Escape, "Ctrl+A")')
      checkWriteTab(session, 'key', args)
      return withSession(session, args, async (pageSession) => {
        if (typeof args.ref === 'string' && args.ref !== '') {
          await pageSession.withRefObject(args.ref, (objectId) =>
            pageSession.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function () { this.focus() }' }),
          )
        } else if (typeof args.selector === 'string' && args.selector !== '') {
          await evaluate(
            pageSession.connection,
            pageSession.sessionId,
            `(() => { const el = document.querySelector(${JSON.stringify(args.selector)});
               if (el === null) return false; el.focus(); return true })()`,
          )
        }
        const result = await pressKey(pageSession.connection, pageSession.sessionId, args.key)
        return { key: args.key, modifiers: result.modifiers }
      })
    }

    case 'select': {
      if (typeof args.selector !== 'string' || args.selector === '') throw new Error('select requires selector')
      if (args.value === undefined && args.values === undefined) throw new Error('select requires value or values')
      checkWriteTab(session, 'select', args)
      return withSession(session, args, async (pageSession) => {
        const values = args.values ?? args.value
        const picked = await selectOption(pageSession.connection, pageSession.sessionId, {
          selector: args.selector,
          values,
          byLabel: args.byLabel === true,
        })
        return { selector: args.selector, ...picked }
      })
    }

    case 'upload': {
      if (typeof args.selector !== 'string' || args.selector === '') throw new Error('upload requires selector')
      if (!Array.isArray(args.files) || args.files.length === 0) throw new Error('upload requires a non-empty files array')
      checkWriteTab(session, 'upload', args)
      // Check the paths before touching the page. `DOM.setFileInputFiles` fails
      // opaquely on a missing file (the browser reports a generic protocol
      // error), so a typo would surface as "upload failed" with no hint which
      // path was wrong. The containment check runs first: this process is
      // outside the agent's sandbox, so an unconstrained path is arbitrary read.
      const resolvedFiles = args.files.map((file) => {
        const resolved = resolveUploadPath(session, file)
        return resolved
      })
      for (const file of resolvedFiles) {
        try {
          const info = await stat(file)
          if (!info.isFile()) throw new Error('not a regular file')
        } catch (error) {
          throw new Error(`upload: cannot read "${file}" — ${error.code ?? error.message}`)
        }
      }
      return withSession(session, args, async (pageSession) => {
        // The chooser has to be intercepted before it can open, or the browser
        // shows a native picker that no protocol call can reach and the page
        // waits on it forever. It is switched off again in a `finally`, because
        // leaving it enabled would swallow every later chooser on this tab —
        // including one the user opens themselves.
        await pageSession.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {})
        try {
          return await setFileInput(pageSession.connection, pageSession.sessionId, {
            selector: args.selector,
            files: resolvedFiles,
          })
        } finally {
          await pageSession.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
        }
      })
    }

    case 'wait': {
      if (
        typeof args.text !== 'string' &&
        typeof args.textGone !== 'string' &&
        typeof args.selector !== 'string' &&
        typeof args.expression !== 'string'
      ) {
        throw new Error('wait requires one of: text, textGone, selector (with gone?), expression')
      }
      return withSession(session, args, async (pageSession) => {
        const result = await waitFor(pageSession.connection, pageSession.sessionId, {
          text: args.text,
          textGone: args.textGone,
          selector: args.selector,
          gone: args.gone === true,
          expression: args.expression,
          timeoutMs: Math.min(Number(args.timeoutMs) || WAIT_BUDGET_MS, WAIT_BUDGET_MS),
          pollMs: Number(args.pollMs ?? 100) || 100,
        })
        // A timeout is a normal answer, not a protocol failure: the caller
        // decides whether the page was merely slow or genuinely wrong.
        return { ok: result?.ok === true, waitedMs: result?.waitedMs ?? result?.elapsedMs ?? null }
      })
    }

    case 'resize': {
      // Resizing a tab the user is looking at makes their window show a
      // different layout than their own — a visible change to their session,
      // even though the override evaporates with the session. So it is a write.
      checkWriteTab(session, 'resize', args)
      return withSession(session, args, async (pageSession) => {
        if (args.clear === true) {
          const cleared = await resizeViewport(pageSession.connection, pageSession.sessionId, null)
          return cleared
        }
        // `Number(true)` is 1 and `Number('375')` is 375: both would pass a
        // finiteness check and silently mean something other than the caller
        // intended, so the type is checked before the value.
        if (typeof args.width !== 'number' || typeof args.height !== 'number') {
          throw new Error('resize requires numeric width and height, or clear:true')
        }
        const width = args.width
        const height = args.height
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw new Error('resize requires positive width and height, or clear:true')
        }
        return resizeViewport(pageSession.connection, pageSession.sessionId, width, height, {
          deviceScaleFactor: Number(args.deviceScaleFactor ?? 1) || 1,
          mobile: args.mobile === true,
        })
      })
    }

    case 'media': {
      // Emulating dark mode on the user's own tab changes what they see, for
      // the same reason `resize` does. Treated as a write.
      checkWriteTab(session, 'media', args)
      return withSession(session, args, async (pageSession) =>
        emulateMedia(pageSession.connection, pageSession.sessionId, {
          colorScheme: args.colorScheme,
          reducedMotion: args.reducedMotion,
          forcedColors: args.forcedColors,
          contrast: args.contrast,
          media: args.media,
        }),
      )
    }

    case 'shot': {
      return withSession(session, args, async (pageSession) => {
        const { png, truncated } = await screenshot(pageSession.connection, pageSession.sessionId, {
          fullPage: args.fullPage === true,
        })
        const image = decodePng(png)
        const dir = resolveShotDir(session, args.out)
        await mkdir(dir, { recursive: true })
        const file = join(dir, `dsh-cdp-${Date.now()}.png`)
        await writeFile(file, png)
        return { path: file, width: image.width, height: image.height, bytes: png.length, truncated }
      })
    }

    case 'assert': {
      if (!Array.isArray(args.checks) || args.checks.length === 0) {
        throw new Error('assert requires a non-empty checks array')
      }
      // Bounded because each check is one or more protocol round trips: an
      // accidental ten-thousand-entry list would hold the browser for minutes
      // with no way to cancel it through this route.
      if (args.checks.length > MAX_CHECKS) {
        throw new Error(`assert accepts at most ${MAX_CHECKS} checks per call (got ${args.checks.length})`)
      }
      // A check that carries `click` writes to the page, so the whole command
      // falls under the write guard. Read-only checks on any tab stay allowed.
      const mutates = args.checks.some((c) => c && c.click !== undefined && c.click !== null)
      if (mutates) checkWriteTab(session, 'assert', args)
      return withSession(session, args, async (pageSession) => {
        const results = await runChecks(pageSession.connection, pageSession.sessionId, args.checks, { pageSession })
        return {
          passed: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          total: results.length,
          results,
        }
      })
    }

    case 'console': {
      return withSession(session, args, async (pageSession, target) => {
        const captured = pageSession.consoleEntries({
          level: typeof args.level === 'string' ? args.level : undefined,
          limit: Number(args.limit ?? 100) || 100,
          maxBytes,
        })
        const entries = captured.entries
        return {
          id: target.targetId,
          url: clipText(target.url ?? '', 200),
          count: entries.length,
          // How many lines were captured but not returned, so a short list is
          // never mistaken for a quiet page.
          captured: captured.total,
          trimmed: captured.trimmed,
          // Capture starts when the session attaches, so a page loaded before
          // the first command has no earlier output. Saying so is the difference
          // between an empty list and a misleading "the page logged nothing".
          note: 'capture starts at the first command on this tab; earlier output is not available',
          entries: entries.map((entry) => ({
            level: entry.level,
            text: entry.text,
            ...(entry.source === undefined ? {} : { source: entry.source }),
            ...(entry.url === undefined || entry.url === null ? {} : { url: entry.url }),
          })),
          dialogs: pageSession.dialogEntries(),
          pendingDialog: pageSession.pendingDialog(),
        }
      })
    }

    case 'dialog': {
      // Answering a dialog is a write to the page. It is allowed only on a tab
      // this session opened: a dialog on the user's own tab belongs to their
      // session, and clicking OK there would discard their unsaved work on
      // their behalf. Reporting what is blocking a tab is a read, so that half
      // works anywhere.
      const answer = args.accept === true || args.dismiss === true
      if (answer) {
        checkWriteTab(session, 'dialog', args)
        return withSession(session, args, async (pageSession) => {
          const record = await pageSession.answerPendingDialog({
            accept: args.accept === true,
            promptText: args.promptText,
          })
          return { answered: true, dialog: record }
        })
      }
      // Without an answer, this reports what is blocking the tab.
      return withSession(session, args, async (pageSession, target) => {
        return {
          id: target.targetId,
          url: clipText(target.url ?? '', 200),
          pending: pageSession.pendingDialog(),
          dialogs: pageSession.dialogEntries(),
        }
      })
    }

    case 'network': {
      return withSession(session, args, async (pageSession, target) => {
        if (args.index !== undefined && args.index !== null) {
          // The per-command output cap applies to this record too: a response
          // body is the one thing here that can be arbitrarily large.
          const detail = await pageSession.networkDetail(Number(args.index), { maxTotalBytes: maxBytes })
          return { id: target.targetId, url: clipText(target.url ?? '', 200), request: detail }
        }
        const list = pageSession.networkList({
          filter: args.filter,
          limit: Number(args.limit ?? 100) || 100,
          maxBytes,
        })
        return {
          id: target.targetId,
          url: clipText(target.url ?? '', 200),
          total: list.total,
          dropped: list.dropped,
          returned: list.returned,
          trimmed: list.trimmed,
          requests: list.requests,
        }
      })
    }

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
  'Drive a Chromium browser already running on this machine (Chrome, Edge, Brave, Vivaldi, Opera, Chromium, Arc, Thorium) over CDP with the shell: DOM/accessibility snapshots, click/hover/drag/type/key, upload, screenshots, viewport/media emulation, console and network, DOM/pixel assertions — against the user\'s real session and logins. Use when a task needs a real page: checking a running web app, reproducing a UI bug, screenshotting, filling forms, waiting for content, debugging console/network, or reading data from a site they are logged into (截图看看 / 页面为什么报错 / 点一下 / 填表单 / 等加载). Do not use it to launch a browser or to write Playwright/Puppeteer scripts.'

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

            // Observation commands answer without joining the command queue.
            // They only read local state (`snapshot()` reads fields, and the
            // browser discovery is filesystem/TCP work), so serialising them
            // buys nothing — but queuing them costs the panel its liveness: a
            // 5s `wait` would hold the status poll for 5s, and the composer icon
            // would freeze exactly while the agent is busy. That is the one
            // moment the indicator exists to report.
            if (OBSERVATION_COMMANDS.has(command)) {
              const result = await runCommand(session, command, args)
              return sendJson(res, 200, { ok: true, ...result })
            }

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
            'Use when a task needs the user\'s real browser: inspecting or driving a running page, DOM/pixel assertions, screenshots, UI bug reproduction, console/network evidence, responsive or print checks, form filling, file upload, or data from a site they are already logged into.',
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

/**
 * Test-only surface, following the convention `client.js` set with its own
 * `__test`. Nothing here is part of the plugin contract.
 */
export const __test = { approvalWatchStep, checkWriteTab, clipText, isLocalHost, resolveShotDir, resolveUploadPath }
