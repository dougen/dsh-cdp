/**
 * CDP client for a browser the user already started.
 *
 * Built on Node built-ins only (`WebSocket`, `fetch`, `node:zlib`) so the
 * plugin carries no dependencies. Two contracts matter more than the CDP
 * surface itself:
 *
 *   - **Every request has a deadline.** A socket that is waiting for the user
 *     to approve remote debugging never opens and never errors — it just hangs.
 *     Without a timeout that hang becomes a hung agent turn.
 *   - **One connection serves every command.** The browser prompts per
 *     *connection*, not per command, so the whole point of the plugin is to
 *     keep this socket alive and reuse it.
 */
import { inflateSync } from 'node:zlib'

/** How long a single CDP request may take before it is abandoned. */
export const DEFAULT_CALL_TIMEOUT_MS = 8000
/** How long the initial handshake may wait for the user to approve. */
export const DEFAULT_OPEN_TIMEOUT_MS = 3000

/** Failure kinds the caller maps onto panel states. */
export const FailureKind = {
  /** The socket neither opened nor errored before the deadline: likely an approval prompt. */
  AwaitingApproval: 'awaiting-approval',
  /** Nothing is listening on the endpoint. */
  Unreachable: 'unreachable',
  /** Connected, but the protocol call failed or timed out. */
  Protocol: 'protocol',
  /** Caller aborted. */
  Aborted: 'aborted',
}

export class CdpError extends Error {
  constructor(message, kind, options) {
    super(message, options)
    this.name = 'CdpError'
    this.kind = kind
  }
}

/** A pending request that has not yet been answered. */
class Pending {
  constructor(resolve, reject, timer, sessionId) {
    this.resolve = resolve
    this.reject = reject
    this.timer = timer
    /** The session the call went through, so it can be failed in bulk. */
    this.sessionId = sessionId
  }
}

/** Sentinel: the wait expired (the socket may still open later). */
const TimedOut = Symbol('timed-out')
/** Sentinel: the caller aborted the wait. */
const Aborted = Symbol('aborted')

/**
 * Race a handshake promise against a deadline and an abort signal.
 *
 * Returns the promise's value on success, the rejection reason as an `Error`,
 * or one of the sentinels. The handshake promise itself is never cancelled —
 * a timeout here only ends *this wait*, because the browser may still complete
 * the handshake once the user approves.
 *
 * @returns the resolved value, an `Error`, {@link TimedOut}, or {@link Aborted}.
 */
function raceHandshake(handshake, timeoutMs, signal) {
  if (signal?.aborted === true) return Promise.resolve(Aborted)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const timer = timeoutMs > 0 ? setTimeout(() => finish(TimedOut), timeoutMs) : null
    const onAbort = () => finish(Aborted)
    signal?.addEventListener('abort', onAbort, { once: true })
    handshake.then(
      (value) => finish(value),
      (error) => finish(error instanceof Error ? error : new Error(String(error))),
    )
  })
}

export class CdpConnection {
  #url
  #ws = null
  #nextId = 0
  #pending = new Map()
  #listeners = new Map()
  /** Socket-loss callbacks; unlike `on`, these fire on the transport dying. */
  #closeCallbacks = new Set()
  #closed = false
  #ready = false
  #attached = false
  #callTimeoutMs
  #socketFactory
  /**
   * Settles once the handshake completes. Created when the socket is built and
   * resolved by a *persistent* listener, so a late approval can never be missed:
   * the `open` event fires exactly once, and a poll that starts after it fires
   * would otherwise wait forever for an event that already happened.
   */
  #handshake = null

  /**
   * @param {string} url
   * @param {object} [options]
   * @param {number} [options.callTimeoutMs]
   * @param {(url: string) => WebSocket} [options.socketFactory] - injected so
   *   tests can supply a fake socket; defaults to the global `WebSocket`.
   */
  constructor(url, { callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS, socketFactory } = {}) {
    this.#url = url
    this.#callTimeoutMs = callTimeoutMs
    this.#socketFactory = socketFactory ?? ((u) => new WebSocket(u))
  }

  get url() {
    return this.#url
  }

  get connected() {
    return this.#ready && this.#ws !== null && this.#ws.readyState === 1
  }

  /**
   * Attach the persistent protocol handlers. Called exactly once, either at
   * handshake time or when a parked socket finally opens after approval.
   */
  #attach() {
    if (this.#attached || this.#ws === null) return
    this.#attached = true
    this.#ready = true
    this.#ws.addEventListener('message', (event) => this.#onMessage(event))
    this.#ws.addEventListener('close', () => this.#notifyClosed())
    this.#ws.addEventListener('error', () => {
      this.#failAll(new CdpError('connection error', FailureKind.Unreachable))
    })
  }

  /**
   * Transport-level loss notification: the socket died after a successful
   * handshake. Distinct from `on`, which only sees CDP protocol events —
   * there is no `close` protocol event, so a listener registered there would
   * never learn that the connection is gone.
   */
  #notifyClosed() {
    // A socket dies exactly once; a stray duplicate `close` event (or one
    // following a deliberate `close()`, which already set the flag) must not
    // run the loss notification twice.
    if (this.#closed) return
    this.#closed = true
    this.#ready = false
    this.#failAll(new CdpError('connection closed', FailureKind.Unreachable))
    for (const fn of [...this.#closeCallbacks]) {
      try {
        fn()
      } catch {
        // A callback fault must not break the rest of the notification.
      }
    }
  }

  /**
   * Subscribe to socket loss (once connected). Returns an unsubscribe function.
   * The connection owner uses this to move its state machine to `disconnected`.
   */
  onClose(fn) {
    this.#closeCallbacks.add(fn)
    return () => this.#closeCallbacks.delete(fn)
  }

  /**
   * Build the socket and install listeners that survive for its whole life.
   *
   * The listeners go on immediately — before any timeout can expire — because
   * the browser may complete the handshake at any moment while the user is
   * deciding. {@link #handshake} records that outcome permanently.
   */
  #ensureSocket() {
    if (this.#ws !== null && !this.#closed) return this.#ws
    const ws = this.#socketFactory(this.#url)
    this.#ws = ws
    this.#handshake = new Promise((resolve, reject) => {
      let settled = false
      ws.addEventListener('open', () => {
        if (settled) return
        settled = true
        this.#attach()
        resolve()
      })
      ws.addEventListener('error', () => {
        if (settled) return
        settled = true
        this.#closed = true
        reject(new CdpError(`WebSocket to ${this.#url} failed`, FailureKind.Unreachable))
      })
      ws.addEventListener('close', () => {
        if (settled) return
        settled = true
        this.#closed = true
        reject(new CdpError(`WebSocket to ${this.#url} closed before opening`, FailureKind.Unreachable))
      })
    })
    // A rejection is observed by whoever awaits it; this no-op guard keeps an
    // unawaited rejection from surfacing as an unhandled rejection.
    this.#handshake.catch(() => {})
    return ws
  }

  /**
   * Open the socket and wait for the handshake.
   *
   * A deadline here is a *feature*, not a failure: it turns "the user has not
   * approved yet" into a reportable state instead of a hang. On timeout the
   * socket is deliberately left open and un-attached — the browser may still be
   * holding an approval prompt for it, and {@link waitForOpen} adopts it later.
   */
  async open({ timeoutMs = DEFAULT_OPEN_TIMEOUT_MS, signal } = {}) {
    if (this.connected) return this
    this.#ensureSocket()
    const outcome = await raceHandshake(this.#handshake, timeoutMs, signal)

    if (outcome === Aborted) {
      this.close()
      throw new CdpError('handshake aborted by caller', FailureKind.Aborted)
    }
    if (outcome === TimedOut) {
      throw new CdpError(
        `no response within ${timeoutMs}ms — the browser may be waiting for you to allow remote debugging`,
        FailureKind.AwaitingApproval,
      )
    }
    if (outcome instanceof Error) throw outcome
    return this
  }

  /**
   * Wait for a parked socket to open, then adopt it.
   *
   * Safe to call repeatedly: the handshake promise is created once, so a call
   * that arrives after the browser already answered resolves immediately rather
   * than waiting for an `open` event that has already fired.
   */
  async waitForOpen({ timeoutMs = 120_000, signal } = {}) {
    if (this.connected) return this
    if (this.#handshake === null) throw new CdpError('no socket to wait on', FailureKind.Unreachable)
    const outcome = await raceHandshake(this.#handshake, timeoutMs, signal)

    if (outcome === Aborted) throw new CdpError('aborted while awaiting approval', FailureKind.Aborted)
    if (outcome === TimedOut) throw new CdpError('still awaiting approval', FailureKind.AwaitingApproval)
    if (outcome instanceof Error) throw outcome
    return this
  }


  #onMessage(event) {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const slot = this.#pending.get(message.id)
      if (slot === undefined) return
      this.#pending.delete(message.id)
      clearTimeout(slot.timer)
      if (message.error) {
        slot.reject(new CdpError(`${message.error.message} (code ${message.error.code})`, FailureKind.Protocol))
      } else {
        slot.resolve(message.result)
      }
      return
    }
    if (message.method !== undefined) {
      for (const listener of [...(this.#listeners.get(message.method) ?? [])]) {
        try {
          listener(message.params, message.sessionId)
        } catch {
          // A listener fault must not break protocol dispatch.
        }
      }
    }
  }

  #failAll(error) {
    for (const slot of this.#pending.values()) {
      clearTimeout(slot.timer)
      slot.reject(error)
    }
    this.#pending.clear()
  }

  /** Send one protocol call, bounded by the call deadline. */
  send(method, params = {}, { sessionId, timeoutMs = this.#callTimeoutMs } = {}) {
    if (!this.connected) {
      return Promise.reject(new CdpError('not connected', FailureKind.Unreachable))
    }
    const id = ++this.#nextId
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    this.#ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CdpError(`${method} timed out after ${timeoutMs}ms`, FailureKind.Protocol))
      }, timeoutMs)
      this.#pending.set(id, new Pending(resolve, reject, timer, sessionId))
    })
  }

  /**
   * Reject every call made through one session.
   *
   * When a tab is closed, the browser never answers the calls that were made
   * against it — they would sit there until their deadline and then report a
   * protocol timeout, which reads as "the browser hung" rather than "that tab
   * is gone". Failing them immediately turns the wait into the accurate
   * answer.
   */
  failSession(sessionId, message) {
    for (const [id, slot] of [...this.#pending]) {
      if (slot.sessionId !== sessionId) continue
      this.#pending.delete(id)
      clearTimeout(slot.timer)
      slot.reject(new CdpError(message, FailureKind.Protocol))
    }
  }

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(method, listener) {
    const list = this.#listeners.get(method) ?? []
    list.push(listener)
    this.#listeners.set(method, list)
    return () => {
      const current = this.#listeners.get(method)
      if (current === undefined) return
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
    }
  }

  /**
   * Wait for one occurrence of a CDP event.
   *
   * `sessionId` narrows the wait to one page's session. That filter is not
   * optional politeness: every page session shares this one socket, so without
   * it a load in any background tab would satisfy a `navigate` waiting on a
   * different tab — the wait would return on the wrong page's event.
   */
  once(method, timeoutMs = 15000, sessionId) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params, eventSessionId) => {
        if (sessionId !== undefined && eventSessionId !== sessionId) return
        clearTimeout(timer)
        off()
        resolve(params)
      })
      const timer = setTimeout(() => {
        off()
        reject(new CdpError(`timed out waiting for ${method}`, FailureKind.Protocol))
      }, timeoutMs)
    })
  }

  close() {
    this.#closed = true
    try {
      this.#ws?.close()
    } catch {
      // Already closing.
    }
    this.#ws = null
    this.#failAll(new CdpError('connection closed', FailureKind.Unreachable))
  }
}

// ---------------------------------------------------------------------------
// Page operations
// ---------------------------------------------------------------------------

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new CdpError('aborted', FailureKind.Aborted))
    }
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })

// ---------------------------------------------------------------------------
// Captured streams and page sessions
// ---------------------------------------------------------------------------

/** Trim a string to a character budget without splitting a surrogate pair. */
function clipText(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  let end = max
  // A high surrogate at the cut would render as a replacement character.
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return `${value.slice(0, end)}…`
}

/** JSON-stringify a value that may not survive it (cycles, proxies, BigInt). */
function safeJson(value) {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/**
 * Clip a string to a byte budget, counting UTF-8 bytes.
 *
 * The character-based `clipText` cannot be used for a byte budget: a string of
 * Chinese characters is three bytes each, so clipping 24 000 characters would
 * produce 72 000 bytes — three times the budget it was given. The cut is placed
 * at a character boundary and never inside a surrogate pair.
 */
function clipToBytes(text, maxBytes) {
  const value = String(text ?? '')
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  if (maxBytes <= 0) return ''
  // Binary search on the character count, then trim the marker to fit.
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= maxBytes) low = mid
    else high = mid - 1
  }
  let end = low
  // A high surrogate at the cut would render as a replacement character.
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  const marker = '…'
  const room = maxBytes - Buffer.byteLength(marker, 'utf8')
  if (room <= 0) return ''
  if (Buffer.byteLength(value.slice(0, end), 'utf8') > room) {
    let low2 = 0
    let high2 = end
    while (low2 < high2) {
      const mid = Math.ceil((low2 + high2) / 2)
      if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= room) low2 = mid
      else high2 = mid - 1
    }
    end = low2
  }
  return `${value.slice(0, end)}${marker}`
}

/**
 * Replace a header map with a count and the names it carried.
 *
 * Used when a header set is too large to ship whole: the names still tell the
 * caller whether the request was authenticated, JSON, compressed, and so on,
 * while a full cookie jar can be tens of kilobytes the agent does not need.
 */
/**
 * A request record as the caller sees it: a copy without the internal clock.
 *
 * The copy matters for the redirect hops as well — `networkList` summarises
 * headers in a spread clone, but the entry it clones from is the live one.
 */
function sanitiseNetwork(entry) {
  const { [CLOCK]: _clock, ...rest } = entry
  return rest
}

function summariseHeaders(headers) {
  if (headers === null || headers === undefined) return null
  const names = Object.keys(headers)
  if (names.length === 0) return null
  return { count: names.length, names: names.slice(0, 40) }
}

/** Cap on console lines kept per page session. */
export const CONSOLE_LIMIT = 200
/** Cap on network requests kept per page session. */
export const NETWORK_LIMIT = 500
/** Cap on dialogs kept per page session. */
export const DIALOG_LIMIT = 20
/** Cap on aria refs a session will resolve. */
const REF_LIMIT = 800
/**
 * Where a request keeps its internal protocol clock reading.
 *
 * Not a reportable field: the reading is monotonic seconds since the browser
 * started, and shipping it as `startedAt` made it look like an epoch number.
 */
const CLOCK = Symbol('cdp-clock')

/**
 * Modifier names as the CDP `modifiers` bitmask.
 *
 * The browser wants a bitfield, not a list: Ctrl+A has to arrive as one
 * keyDown carrying `modifiers: 2`, because the accelerator is matched inside
 * the renderer. Sending a separate Ctrl press first does not work — the key
 * state is not sticky across protocol calls.
 */
const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 }

/**
 * Modifier-only keys: pressed with no text, they never type anything.
 *
 * `AltGraph` is deliberately absent: it has no modifier bit in the CDP mask
 * (AltGr is Ctrl+Alt at the keyboard level), so sending it would produce a key
 * event with `key: "AltGraph"`, `keyCode: 0` and no modifier set — a combination
 * a real browser never emits. `Ctrl+Alt+<key>` is the honest way to express it,
 * and `parseKeySpec` reports an unknown modifier for anything else.
 */
const MODIFIER_KEYS = new Set(['Control', 'Ctrl', 'Shift', 'Alt', 'Meta', 'Cmd', 'Command'])

/**
 * Named keys, mapped to what `Input.dispatchKeyEvent` needs.
 *
 * `text` is what makes the renderer perform the default action — Enter
 * submitting a form, Space toggling a checkbox. A key without `text` is sent as
 * `rawKeyDown`, which is the correct type for keys that produce no character.
 * Enter carries `\r` rather than `\n`: that is what Chromium's own key handling
 * emits, and a form submit is matched on it.
 */
const KEY_TABLE = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27, key: 'Escape' },
  Esc: { code: 'Escape', keyCode: 27, key: 'Escape' },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Insert: { code: 'Insert', keyCode: 45 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', key: ' ', keyCode: 32, text: ' ' },
  ' ': { code: 'Space', key: ' ', keyCode: 32, text: ' ' },
}

for (let n = 1; n <= 12; n += 1) KEY_TABLE[`F${n}`] = { code: `F${n}`, keyCode: 111 + n }

/**
 * Resolve one key name into the shape `Input.dispatchKeyEvent` wants.
 *
 * Three kinds of input reach this: a named key (`Enter`, `ArrowDown`), a single
 * printable character (`a`, `?`), and a modifier held with another key
 * (`Ctrl+A` — parsed by the caller, so `name` here is just `A`).
 */
function describeKey(name) {
  const named = KEY_TABLE[name] ?? KEY_TABLE[name.charAt(0).toUpperCase() + name.slice(1)]
  if (named !== undefined) {
    return { code: named.code, keyCode: named.keyCode, key: named.key ?? name, text: named.text }
  }
  if (name.length !== 1) {
    // AltGr has no modifier bit in the protocol's mask (it is Ctrl+Alt at the
    // keyboard level), so a dedicated name could only be sent as a key with no
    // modifier set — a combination no browser produces. The chord spells it.
    if (name.toLowerCase() === 'altgraph' || name.toLowerCase() === 'altgr') {
      throw new CdpError(
        'AltGr has no single modifier in the protocol — use "Ctrl+Alt+<key>" instead',
        FailureKind.Protocol,
      )
    }
    throw new CdpError(
      `unknown key "${name}" — use a single character, or one of: ${Object.keys(KEY_TABLE).join(', ')}`,
      FailureKind.Protocol,
    )
  }
  const upper = name.toUpperCase()
  if (/^[A-Z]$/.test(upper)) {
    return { code: `Key${upper}`, keyCode: upper.charCodeAt(0), key: name, text: name }
  }
  if (/^[0-9]$/.test(name)) {
    return { code: `Digit${name}`, keyCode: name.charCodeAt(0), key: name, text: name }
  }
  return { code: '', keyCode: name.charCodeAt(0), key: name, text: name }
}

/** Parse `"Ctrl+Shift+A"` into `{ name: 'A', modifiers: 10, held: [...] }`. */
export function parseKeySpec(spec) {
  if (typeof spec !== 'string' || spec === '') throw new CdpError('key requires a key name', FailureKind.Protocol)
  const parts = spec.split('+')
  let name = parts.pop()
  // The plus key itself arrives as an empty trailing segment: "Ctrl++" and "+".
  if (name === '') {
    name = '+'
    if (parts.at(-1) === '') parts.pop()
  }
  let modifiers = 0
  for (const part of parts) {
    const bit = part === '' ? undefined : MODIFIER_BITS[part.toLowerCase()]
    if (bit === undefined) throw new CdpError(`unknown modifier "${part}" in "${spec}"`, FailureKind.Protocol)
    modifiers |= bit
  }
  return { name, modifiers, held: parts }
}

/**
 * The point-and-cover test shared by click, hover, and drag.
 *
 * `this` is checked by shape, not only by `null`: this function is invoked as
 * `.call(document.querySelector(...))`, and in sloppy mode `.call(null)` passes
 * the *global object* rather than null. Without the shape guard a missing
 * element reaches `getBoundingClientRect` as `window` and throws a TypeError,
 * which surfaces as a protocol error instead of "no element matches".
 */
const POINT_FN = `function () {
  'use strict';
  const el = this;
  if (el === null || el === undefined || typeof el.getBoundingClientRect !== 'function') return null;
  // Scroll the element into view without calling scrollIntoView: that call
  // bubbles all the way to the document, so clicking an element inside a modal
  // or a drawer also scrolled the page behind it — the modal stayed put while
  // the page under it jumped. The nearest scrollport is tried first, so a
  // nested scroller moves its own content and leaves the document alone.
  const doc = document.scrollingElement || document.documentElement;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const settle = () => {
    const box = el.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= vh && box.left >= 0 && box.right <= vw;
  };
  let box = el.getBoundingClientRect();
  for (let node = el.parentElement; node !== null && !settle(); node = node.parentElement) {
    if (node === doc) continue;
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowX) && (box.left < 0 || box.right > vw)) {
      node.scrollLeft += box.left + box.width / 2 - vw / 2;
    }
    if (/(auto|scroll|overlay)/.test(style.overflowY) && (box.top < 0 || box.bottom > vh)) {
      node.scrollTop += box.top + box.height / 2 - vh / 2;
    }
    box = el.getBoundingClientRect();
  }
  if (!settle()) {
    box = el.getBoundingClientRect();
    if (box.top < 0 || box.bottom > vh) doc.scrollTop += box.top + box.height / 2 - vh / 2;
    box = el.getBoundingClientRect();
    if (box.left < 0 || box.right > vw) doc.scrollLeft += box.left + box.width / 2 - vw / 2;
  }
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { dom: true };
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  // Whether the point is inside the viewport. A fixed-position element parked
  // off-screen has a real box but no reachable coordinates: clicking them would
  // dispatch an event at a negative position, which the page never sees, and
  // the command would report success.
  const inViewport = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
  const hit = inViewport ? document.elementFromPoint(x, y) : null;
  const covered = hit !== null && hit !== el && !el.contains(hit) && !(hit.contains && hit.contains(el));
  return { dom: false, x, y, covered, inViewport, w: r.width, h: r.height, tag: el.tagName.toLowerCase(), type: el.type || null };
}`

/**
 * What sits at a viewport point, in the shape {@link dispatchPoint} acts on.
 *
 * A check that clicks by coordinates has no element to measure, so the element
 * under the point is measured instead. Returns `null` outside the viewport:
 * there is nothing there to click.
 */
const POINT_AT_FN = `function (x, y) {
  'use strict';
  if (!(x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight)) return null;
  const hit = document.elementFromPoint(x, y);
  if (hit === null) return null;
  return { dom: false, x, y, covered: false, inViewport: true, w: 0, h: 0, tag: hit.tagName.toLowerCase(), type: hit.type || null };
}`

/**
 * One page target's CDP session, kept alive between commands.
 *
 * The connection is at the browser level, so a page session must be attached
 * before any page-scoped call. Two designs were possible:
 *
 *   - attach → run → detach per command (the previous shape). Simple, but every
 *     event stream dies with the session, so console output and network
 *     requests cannot be observed across commands at all — they are, by
 *     construction, gone before the next command asks for them.
 *   - attach once, keep the session, buffer what arrives. That is what this
 *     class is for, and it is the difference between `console`/`network`
 *     returning something and returning nothing.
 *
 * The cost is honest: while attached, the session is subscribed to a target
 * that may be the user's own tab. So subscriptions are read-only (console,
 * network, dialog notifications), buffers are capped, and the one action it can
 * take automatically — answering a dialog — is decided by the caller's ownership
 * rule rather than assumed here.
 */
export class PageSession {
  #connection
  #targetId
  #sessionId
  #dialogPolicy
  #console = []
  #network = new Map()
  #networkOrder = []
  #networkDropped = 0
  /** Monotonic request numbering; a handle a caller was given never shifts. */
  #networkSeq = 0
  /** Requests whose loading stage has ended, so `durationMs` stops growing. */
  #networkDone = new Set()
  #dialogs = []
  /** A dialog left open on purpose, blocking the page until it is answered. */
  #pendingDialog = null
  #refs = new Map()
  /** Ref numbers never repeat within a session, so a stale ref cannot alias. */
  #refSeq = 0
  #offs = []
  #closed = false

  constructor(connection, targetId, sessionId, { dialogPolicy = 'ignore' } = {}) {
    this.#connection = connection
    this.#targetId = targetId
    this.#sessionId = sessionId
    this.#dialogPolicy = dialogPolicy
  }

  /**
   * A protocol `timestamp` (monotonic seconds since browser start) in ms.
   *
   * Kept internal: it is only meaningful as a difference of two readings, so
   * exposing it as `startedAt` made it read like an epoch number it never was.
   */
  #clock(seconds) {
    return typeof seconds === 'number' ? Math.round(seconds * 1000) : null
  }

  /** Milliseconds from the request's start to a later clock reading. */
  #durationMs(requestId, timestamp) {
    const started = this.#network.get(requestId)?.[CLOCK]
    if (started === null || started === undefined) return null
    const ended = this.#clock(timestamp)
    return ended === null ? null : Math.max(0, ended - started)
  }

  get targetId() {
    return this.#targetId
  }

  get sessionId() {
    return this.#sessionId
  }

  get connection() {
    return this.#connection
  }

  get closed() {
    return this.#closed
  }

  /** Send one page-scoped protocol call. */
  send(method, params = {}, options = {}) {
    if (this.#closed) throw new CdpError('page session is closed', FailureKind.Protocol)
    return this.#connection.send(method, params, { ...options, sessionId: this.#sessionId })
  }

  /** Subscribe the session's event handlers. */
  #listen() {
    const c = this.#connection
    const sid = this.#sessionId
    const on = (method, fn) => this.#offs.push(c.on(method, (params, eventSession) => {
      if (eventSession !== sid) return
      try {
        fn(params)
      } catch {
        // A capture fault must never break protocol dispatch.
      }
    }))

    on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args ?? [])
        .map((arg) => {
          if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : safeJson(arg.value)
          if (arg.unserializableValue !== undefined) return String(arg.unserializableValue)
          return arg.description ?? arg.type ?? ''
        })
        .join(' ')
      this.#pushConsole({ level: params.type ?? 'log', text: clipText(text, 2000), ts: Date.now() })
    })

    on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails ?? {}
      // A thrown primitive has no `description`; its text lives in `value`.
      // Reading only the description reduced `throw "boom"` to "Uncaught".
      const exception = details.exception ?? {}
      const text =
        exception.description ??
        (exception.value === undefined ? undefined : String(exception.value)) ??
        details.text ??
        'uncaught exception'
      this.#pushConsole({ level: 'error', text: clipText(String(text).split('\n')[0], 2000), ts: Date.now() })
    })

    // A new document means every ref from the previous one is stale, and the
    // browser has already released their handles. Clearing the table makes the
    // next use say "take a fresh snapshot" instead of resolving into the new
    // document at a reused node id.
    on('Runtime.executionContextsCleared', () => {
      this.#refs.clear()
    })

    // Log entries are a separate stream from console: they carry CSP
    // violations, failed resource loads, and deprecations that never pass
    // through `console.*` at all.
    on('Log.entryAdded', (params) => {
      const entry = params.entry ?? {}
      this.#pushConsole({
        level: entry.level === 'warning' ? 'warning' : (entry.level ?? 'info'),
        text: clipText(String(entry.text ?? ''), 2000),
        source: entry.source ?? null,
        url: entry.url ?? null,
        ts: Date.now(),
      })
    })

    on('Network.requestWillBeSent', (params) => {
      const request = params.request ?? {}
      const existing = this.#network.get(params.requestId)
      // A redirect reuses the request id: the steps before the final one are
      // kept on the record rather than overwritten, so `network` shows the chain
      // instead of only the URL that happened to arrive last.
      if (existing !== undefined && params.redirectResponse !== undefined) {
        const redirect = existing.redirects ?? (existing.redirects = [])
        redirect.push({
          url: existing.url,
          status: params.redirectResponse.status ?? null,
          location: params.redirectResponse.headers?.location ?? params.redirectResponse.headers?.Location ?? null,
        })
      }
      this.#pushNetwork({
        requestId: params.requestId,
        method: request.method ?? 'GET',
        url: request.url ?? '',
        resourceType: params.type ?? null,
        status: null,
        mimeType: null,
        wallMs: params.wallTime === undefined ? null : Math.round(params.wallTime * 1000),
        postData: request.postData === undefined ? null : clipText(String(request.postData), 800),
        requestHeaders: request.headers ?? null,
        failed: null,
        // Internal clock reading, consumed by the loadingFinished handler.
        [CLOCK]: this.#clock(params.timestamp),
      })
    })

    on('Network.responseReceived', (params) => {
      const entry = this.#network.get(params.requestId)
      if (entry === undefined) return
      const response = params.response ?? {}
      entry.status = response.status ?? null
      entry.mimeType = response.mimeType ?? null
      entry.responseHeaders = response.headers ?? null
      // Time to first byte. Kept apart from the duration: this is the point
      // where the response started, not where the loading ended.
      entry.ttfbMs = this.#durationMs(params.requestId, params.timestamp)
      if (response.fromDiskCache === true) entry.fromCache = 'disk'
      else if (response.fromMemoryCache === true || response.fromPrefetchCache === true) entry.fromCache = 'memory'
      else if (response.fromServiceWorker === true) entry.fromCache = 'service-worker'
    })

    // The duration belongs to the end of the loading, not to the first byte: a
    // body that streams for two seconds is a two-second request, and measuring
    // at `responseReceived` reported it as a few milliseconds.
    on('Network.loadingFinished', (params) => {
      this.#networkDone.add(params.requestId)
      const entry = this.#network.get(params.requestId)
      if (entry !== undefined) entry.durationMs = this.#durationMs(params.requestId, params.timestamp)
    })

    on('Network.loadingFailed', (params) => {
      const entry = this.#network.get(params.requestId)
      if (entry === undefined) return
      entry.failed = params.errorText ?? 'failed'
      // A request the page aborted itself is not a network fault, and the
      // difference decides whether the caller looks for a bug in the server.
      if (params.canceled === true) entry.failed = `canceled (${entry.failed})`
      else if (params.blockedReason !== undefined) entry.failed = `blocked: ${params.blockedReason}`
      entry.durationMs = this.#durationMs(params.requestId, params.timestamp)
    })

    on('Page.javascriptDialogOpening', (params) => {
      const accept = this.#dialogPolicy === 'accept'
      const handled = this.#dialogPolicy !== 'ignore'
      const record = {
        type: params.type ?? 'alert',
        message: clipText(String(params.message ?? ''), 500),
        defaultPrompt: params.defaultPrompt ?? null,
        action: handled ? (accept ? 'accepted' : 'dismissed') : 'ignored',
        ts: Date.now(),
      }
      this.#dialogs.push(record)
      if (this.#dialogs.length > DIALOG_LIMIT) this.#dialogs.shift()
      if (!handled) {
        // The dialog stays open and the page stays blocked. It is recorded as
        // pending so a `dialog` command can answer it later — otherwise the
        // tab is unusable until the user clicks it themselves.
        this.#pendingDialog = record
        return
      }
      // A page blocked on a dialog answers nothing: this call is what unblocks
      // it, and it must not be awaited here (the listener is synchronous).
      this.#connection
        .send('Page.handleJavaScriptDialog', { accept }, { sessionId: sid, timeoutMs: 5000 })
        .catch(() => {})
    })
  }

  /**
   * Answer the dialog that is currently blocking this page.
   *
   * A pending dialog is one the plugin deliberately left open — it belongs to a
   * tab the session does not own, so answering it would be a write to the
   * user's session. The agent reads the dialog list, asks the user what to do,
   * and then answers it through this.
   */
  async answerPendingDialog({ accept = false, promptText } = {}) {
    if (this.#pendingDialog === null) {
      throw new CdpError('no dialog is waiting on this tab', FailureKind.Protocol)
    }
    const record = this.#pendingDialog
    this.#pendingDialog = null
    await this.send('Page.handleJavaScriptDialog', {
      accept,
      ...(promptText === undefined || promptText === null ? {} : { promptText: String(promptText) }),
    })
    record.action = accept ? 'accepted' : 'dismissed'
    record.answered = true
    return { ...record }
  }

  /** The dialog currently blocking the page, if any. */
  pendingDialog() {
    return this.#pendingDialog === null ? null : { ...this.#pendingDialog }
  }

  /** Enable the domains whose events are captured. */
  async init() {
    this.#listen()
    const enable = (method, params) => this.send(method, params ?? {}).catch(() => {})
    // Runtime and Page must be on or their events never arrive — waiting on an
    // event from a disabled domain is a guaranteed timeout, not a race.
    await this.send('Runtime.enable')
    await this.send('Page.enable')
    // Captures are best-effort: a browser that refuses Log.enable (some
    // distributions gate it) still gets console and network.
    await enable('Log.enable')
    await enable('Network.enable', { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 5_000_000 })
    return this
  }

  #pushConsole(entry) {
    this.#console.push(entry)
    if (this.#console.length > CONSOLE_LIMIT) this.#console.shift()
  }

  /** Store or refresh one request, keeping insertion order and the cap. */
  #pushNetwork(entry) {
    const existing = this.#network.get(entry.requestId)
    if (existing !== undefined) {
      // The start of the request is fixed: a second `requestWillBeSent` for the
      // same id is a redirect hop, and moving the start with it would shorten
      // the measured duration by exactly the time spent on the first hop.
      const started = existing[CLOCK]
      Object.assign(existing, entry)
      existing[CLOCK] = started
      return
    }
    // A monotonically increasing number, never reused, so a request keeps the
    // same handle for the whole session. Position-in-list would not survive the
    // ring buffer dropping older entries: every index would silently shift.
    this.#networkSeq += 1
    entry.index = this.#networkSeq
    this.#network.set(entry.requestId, entry)
    this.#networkOrder.push(entry.requestId)
    while (this.#networkOrder.length > NETWORK_LIMIT) {
      const dropped = this.#networkOrder.shift()
      this.#network.delete(dropped)
      this.#networkDropped += 1
    }
  }

  /**
   * Captured console output, oldest first.
   *
   * `maxBytes` bounds the serialized result. A hundred log lines of two
   * kilobytes each is two hundred kilobytes, which is an order of magnitude
   * over the response budget and would be carried into every later request. The
   * text is clipped first — it is the part that grows — and rows are dropped
   * from the front until the result fits.
   */
  consoleEntries({ level, limit = 100, maxBytes = 24_000 } = {}) {
    const filtered = level === undefined ? this.#console : this.#console.filter((e) => e.level === level)
    const cap = Math.max(1, limit)
    let selected = filtered.slice(-cap)
    const sizeOf = (list) => Buffer.byteLength(JSON.stringify(list), 'utf8')
    let trimmed = false
    if (sizeOf(selected) > maxBytes) {
      // Give each line an equal share of what is left, so one huge line
      // cannot crowd out the others. The share is a byte budget, so it is cut
      // in bytes: a line of Chinese text is three bytes per character, and a
      // character-based cut would overrun the share three times over.
      const perLine = Math.max(200, Math.floor(maxBytes / Math.max(1, selected.length)))
      selected = selected.map((entry) => ({ ...entry, text: clipToBytes(entry.text, perLine) }))
      trimmed = true
    }
    while (selected.length > 1 && sizeOf(selected) > maxBytes) {
      selected = selected.slice(1)
      trimmed = true
    }
    return { entries: selected, total: filtered.length, trimmed }
  }

  /** Captured dialogs, oldest first. Copies: the records are mutable state. */
  dialogEntries() {
    return this.#dialogs.map((record) => ({ ...record }))
  }

  /**
   * The numbered request list, oldest first.
   *
   * `index` is the request's own sequence number (see `#pushNetwork`), so the
   * number shown here is the number `networkDetail` accepts — including when a
   * `filter` hid most of the list, and after the ring buffer dropped entries.
   *
   * `maxBytes` bounds the serialized result. A hundred requests that each carry
   * a few kilobytes of headers come to megabytes, and that whole payload would
   * ride every later model request. When the budget is exceeded the headers
   * are reduced to their names first — the URL, method and status identify a
   * request, the headers rarely do — and the number of rows is trimmed.
   */
  networkList({ filter, limit = 100, maxBytes = 24_000 } = {}) {
    let pattern = null
    if (typeof filter === 'string' && filter !== '') {
      try {
        pattern = new RegExp(filter)
      } catch {
        throw new CdpError(`filter "${filter}" is not a valid regular expression`, FailureKind.Protocol)
      }
    }
    const rows = []
    for (const requestId of this.#networkOrder) {
      const entry = this.#network.get(requestId)
      if (entry === undefined) continue
      if (pattern !== null && !pattern.test(entry.url)) continue
      rows.push(sanitiseNetwork(entry))
    }
    const total = rows.length
    const dropped = this.#networkDropped
    const cap = Math.max(1, limit)
    let selected = rows.slice(-cap)
    let trimmed = false

    const sizeOf = (list) => Buffer.byteLength(JSON.stringify(list), 'utf8')
    if (sizeOf(selected) > maxBytes) {
      // First the headers, which dominate the size and identify the least.
      selected = selected.map((entry) => ({
        ...entry,
        requestHeaders: summariseHeaders(entry.requestHeaders),
        responseHeaders: summariseHeaders(entry.responseHeaders),
      }))
      trimmed = true
    }
    while (selected.length > 1 && sizeOf(selected) > maxBytes) {
      selected = selected.slice(1)
      trimmed = true
    }
    return {
      total,
      dropped,
      trimmed,
      returned: selected.length,
      requests: selected,
    }
  }

  /**
   * The full record for one request, including its response body when kept.
   *
   * `maxTotalBytes` bounds the whole record, not just the body. Headers alone
   * can run to tens of kilobytes on a cookie-heavy request, and the response
   * cap elsewhere in the plugin (24KB by default) would be quietly exceeded by
   * a single detail call — which then rides every later model request. The body
   * is clipped last and its clip is reported, so a large body is visibly
   * truncated rather than silently shortened.
   */
  async networkDetail(index, { maxTotalBytes = 24_000 } = {}) {
    const wanted = Number(index)
    let entry
    for (const requestId of this.#networkOrder) {
      const candidate = this.#network.get(requestId)
      if (candidate !== undefined && candidate.index === wanted) {
        entry = candidate
        break
      }
    }
    if (entry === undefined) {
      const range = this.#networkOrder.length === 0 ? 'nothing captured yet' : `kept ${this.#networkOrder.length}`
      throw new CdpError(
        `no request #${index} (${range}) — run cmd=network first; only the last ${NETWORK_LIMIT} are kept`,
        FailureKind.Protocol,
      )
    }
    const detail = sanitiseNetwork(entry)
    // Response bodies live in the browser's own buffer and are only readable
    // while it still holds them: after a navigation they are gone, which is a
    // normal outcome rather than a failure.
    try {
      const body = await this.send('Network.getResponseBody', { requestId: entry.requestId })
      if (typeof body?.body === 'string') {
        const size = Buffer.byteLength(body.body, 'utf8')
        detail.body = body.body
        detail.bodyBytes = size
        detail.bodyBase64 = body?.base64Encoded === true
      } else {
        detail.body = null
      }
    } catch (error) {
      detail.body = null
      detail.bodyNote = error instanceof Error ? error.message : String(error)
    }

    // Fit the record into the budget by shrinking the body first: the headers
    // and status are what identify the request, the body is what can be huge.
    const head = { ...detail, body: null }
    const headerBytes = Buffer.byteLength(JSON.stringify(head), 'utf8')
    const bodyBudget = Math.max(0, maxTotalBytes - headerBytes)
    if (typeof detail.body === 'string' && Buffer.byteLength(detail.body, 'utf8') > bodyBudget) {
      detail.body = clipToBytes(detail.body, bodyBudget)
      detail.bodyTruncated = true
    }
    if (headerBytes >= maxTotalBytes) {
      // Even without the body the headers do not fit: drop them to a count.
      detail.requestHeaders = summariseHeaders(entry.requestHeaders)
      detail.responseHeaders = summariseHeaders(entry.responseHeaders)
      detail.headersNote = 'headers were too large to include in full'
    }
    return detail
  }

  /**
   * Register the refs produced by a snapshot.
   *
   * The ref table is *replaced*, not merged, because a snapshot describes the
   * page as it is now: a ref from an earlier snapshot may name an element that
   * has since been replaced by a different one. Merging would let a stale ref
   * keep resolving — to the wrong element, silently, with the click reported
   * as successful.
   *
   * The numbers themselves never repeat. They come from one counter that runs
   * for the session's life, so a ref handed out by an earlier snapshot is not
   * re-issued to a different element by a later one. That is what turns "the
   * page changed under your ref" into a clear "unknown ref" error instead of a
   * click on the wrong target. The cost is that the numbers grow across
   * snapshots; they stay short because only a few hundred are ever issued.
   */
  setRefs(nodes) {
    this.#refs.clear()
    return nodes.map((node) => {
      if (node.backendDOMNodeId === null || this.#refSeq >= REF_LIMIT) return { ...node, ref: null }
      this.#refSeq += 1
      const ref = `e${this.#refSeq}`
      this.#refs.set(ref, node.backendDOMNodeId)
      return { ...node, ref }
    })
  }

  /**
   * Run `fn` against the live object handle for a ref, then release it.
   *
   * The handle is a browser-side reference: resolving a node without releasing
   * it leaves one remote object alive until the next navigation, so a long
   * session clicking the same refs would accumulate them without bound.
   */
  async withRefObject(ref, fn) {
    const backendNodeId = this.#refs.get(ref)
    if (backendNodeId === undefined) {
      throw new CdpError(
        `unknown ref "${ref}" — take a fresh snapshot (cmd=snapshot with aria:true) and use a ref from it`,
        FailureKind.Protocol,
      )
    }
    const { object } = await this.send('DOM.resolveNode', { backendNodeId })
    if (object?.objectId === undefined || object.objectId === '') {
      throw new CdpError(`ref "${ref}" no longer points at a live node — take a fresh snapshot`, FailureKind.Protocol)
    }
    try {
      return await fn(object.objectId)
    } finally {
      await this.send('Runtime.releaseObject', { objectId: object.objectId }, { timeoutMs: 3000 }).catch(() => {})
    }
  }

  /**
   * Resolve a target to a viewport point.
   *
   * `ref` and `selector` are two ways to name the same thing, and the point
   * test is identical once the element is in hand — so the element resolution
   * is the only part that differs. Returns `{ dom: true }` when the element has
   * no box (nothing to point at), which callers translate into a DOM-level
   * action.
   */
  async pointFor({ ref, selector } = {}) {
    let value
    if (typeof ref === 'string' && ref !== '') {
      value = await this.withRefObject(ref, async (objectId) => {
        const result = await this.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: POINT_FN,
          returnByValue: true,
        })
        return result?.result?.value
      })
    } else if (typeof selector === 'string' && selector !== '') {
      value = await evaluate(
        this.#connection,
        this.#sessionId,
        `(${POINT_FN}).call(document.querySelector(${JSON.stringify(selector)}))`,
      )
    } else {
      throw new CdpError('this command needs a selector or a ref from snapshot', FailureKind.Protocol)
    }
    if (value === null || value === undefined) {
      const what = ref !== undefined && ref !== '' ? `ref ${ref}` : `selector ${selector}`
      throw new CdpError(`no element matches ${what}`, FailureKind.Protocol)
    }
    return value
  }

  /** Detach and stop capturing. Idempotent. */
  async close({ detach = true } = {}) {
    if (this.#closed) return
    this.#closed = true
    for (const off of this.#offs.splice(0)) {
      try {
        off()
      } catch {
        // Already gone.
      }
    }
    if (!detach) return
    try {
      await this.#connection.send('Target.detachFromTarget', { sessionId: this.#sessionId }, { timeoutMs: 3000 })
    } catch {
      // The target is usually already gone; detaching is best-effort.
    }
  }
}

/**
 * The set of page sessions this connection holds, one per target.
 *
 * Kept separate from {@link PageSession} because the ownership questions
 * ("is this target still alive", "which session belongs to which tab") belong
 * to the connection's lifetime, not to a single page.
 */
export class PageSessions {
  #connection
  #options
  #bySession = new Map()
  #byTarget = new Map()
  /** In-flight attaches, keyed by targetId, so concurrent acquires share one. */
  #pending = new Map()
  #attachedHandler = null
  #destroyedHandler = null
  #disconnectedHandler = null

  /**
   * @param options.dialogPolicy - `'dismiss' | 'accept' | 'ignore'`
   * @param options.dialogPolicyFor - `(targetId) => policy`; overrides the above
   *   per tab, which is how owned tabs get dialogs answered while the user's own
   *   tabs are left alone.
   */
  constructor(connection, options = {}) {
    this.#connection = connection
    this.#options = options
    // A tab the user closes takes its session with it. Dropping the entry here
    // is what turns the next command's error into "no page target" instead of a
    // silent timeout against a session that no longer exists.
    //
    // The sessionId comparison is load-bearing. Attaching twice to one target is
    // possible across a reconnect or a lost race, and both attachments detach
    // independently. Without the check, the detach of the *stale* one would delete
    // the map entry of the *live* one — `peek` would then miss, every later
    // command would attach again, and the console/network captures of the live
    // session would be silently discarded while it stayed usable.
    this.#destroyedHandler = connection.on('Target.detachedFromTarget', (params) => {
      // The tab is gone. Calls that were in flight against it will never be
      // answered, so they are failed now instead of at their deadline — a
      // closed tab should say so, not look like a hung browser.
      connection.failSession(params.sessionId, 'the tab was closed while the command was running')
      const targetId = this.#bySession.get(params.sessionId)
      if (targetId === undefined) return
      this.#bySession.delete(params.sessionId)
      const session = this.#byTarget.get(targetId)
      if (session === undefined) return
      if (session.sessionId !== params.sessionId) return
      this.#byTarget.delete(targetId)
      session.close({ detach: false }).catch(() => {})
    })
    this.#attachedHandler = connection.onClose(() => {
      // The socket is gone: detaching would be a call into a dead transport.
      for (const session of this.#byTarget.values()) session.close({ detach: false }).catch(() => {})
      this.#byTarget.clear()
      this.#bySession.clear()
      this.#pending.clear()
    })
    // A crashed or force-closed tab raises `Target.disconnected`, not always
    // `Target.detachedFromTarget`: without this the dead session stays in the
    // maps, every later command waits out its deadline, and the crash reads as
    // "the browser hung" instead of "that tab is gone".
    this.#disconnectedHandler = connection.on('Target.disconnected', (params) => {
      const targetId = params.targetId
      const session = targetId === undefined ? undefined : this.#byTarget.get(targetId)
      if (session === undefined) return
      connection.failSession(session.sessionId, 'the tab disconnected (it crashed or was closed)')
      this.#byTarget.delete(targetId)
      this.#bySession.delete(session.sessionId)
      session.close({ detach: false }).catch(() => {})
    })
  }

  /** An existing live session for a target, or `undefined`. */
  peek(targetId) {
    const session = this.#byTarget.get(targetId)
    return session !== undefined && !session.closed ? session : undefined
  }

  /**
   * Attach a session, or return the live one already held for this target.
   *
   * Concurrent callers for the same target share one `Target.attachToTarget`
   * call. Two attachments to one target are not merely wasteful: the browser
   * then has two sessions for it, and detaching either one raises
   * `Target.detachedFromTarget` for a sessionId that the other caller may be
   * actively using.
   */
  async acquire(targetId) {
    const existing = this.peek(targetId)
    if (existing !== undefined) return existing
    const inFlight = this.#pending.get(targetId)
    if (inFlight !== undefined) return inFlight

    const attaching = this.#attach(targetId).finally(() => {
      // Only this attempt clears its own slot: a later acquire may have started
      // another one after a failure.
      if (this.#pending.get(targetId) === attaching) this.#pending.delete(targetId)
    })
    this.#pending.set(targetId, attaching)
    return attaching
  }

  /** One attach attempt; the caller owns de-duplication. */
  async #attach(targetId) {
    const { sessionId } = await this.#connection.send('Target.attachToTarget', { targetId, flatten: true })
    const policy =
      typeof this.#options.dialogPolicyFor === 'function'
        ? this.#options.dialogPolicyFor(targetId)
        : (this.#options.dialogPolicy ?? 'ignore')
    const session = new PageSession(this.#connection, targetId, sessionId, { dialogPolicy: policy })
    this.#bySession.set(sessionId, targetId)
    this.#byTarget.set(targetId, session)
    try {
      await session.init()
    } catch (error) {
      // A half-initialised session must not be handed out: the caller would
      // then run commands against a session whose events never arrive. The
      // attach itself succeeded, so it is detached for real (not `detach:false`)
      // — otherwise a failed init would leave an orphaned session on the
      // browser side that this plugin no longer tracks, and leave this map
      // entry pointing at it.
      if (this.#byTarget.get(targetId) === session) this.#byTarget.delete(targetId)
      this.#bySession.delete(sessionId)
      await session.close({ detach: true }).catch(() => {})
      throw error
    }
    return session
  }

  /** Drop a target's session without detaching (the target is already gone). */
  forget(targetId) {
    const session = this.#byTarget.get(targetId)
    if (session === undefined) return
    this.#byTarget.delete(targetId)
    this.#bySession.delete(session.sessionId)
    session.close({ detach: false }).catch(() => {})
  }

  /** Detach every session; used when the connection is deliberately dropped. */
  async closeAll() {
    const sessions = [...this.#byTarget.values()]
    this.#byTarget.clear()
    this.#bySession.clear()
    await Promise.all(sessions.map((session) => session.close({ detach: false }).catch(() => {})))
  }

  /** Number of live page sessions (the panel's `attached` count). */
  get size() {
    return this.#byTarget.size
  }

  /**
   * Stop listening for connection-level events and drop every page session.
   *
   * Both halves matter. Unsubscribing the container alone would leave each
   * `PageSession`'s own `#offs` handlers registered on the connection — they
   * survive as long as the connection object does, which after a reconnect is
   * the *old* socket that nothing reads from. Dropping the sessions closes
   * those handlers, so a reconnect cannot accumulate a second set.
   */
  dispose() {
    try {
      this.#attachedHandler?.()
    } catch {
      // Already gone.
    }
    try {
      this.#destroyedHandler?.()
    } catch {
      // Already gone.
    }
    try {
      this.#disconnectedHandler?.()
    } catch {
      // Already gone.
    }
    this.#attachedHandler = null
    this.#destroyedHandler = null
    this.#disconnectedHandler = null
    const sessions = [...this.#byTarget.values()]
    this.#byTarget.clear()
    this.#bySession.clear()
    for (const session of sessions) session.close({ detach: false }).catch(() => {})
  }
}

/** Evaluate an expression in a page and return its JSON value. */
export async function evaluate(connection, sessionId, expression, { awaitPromise = true, userGesture = false } = {}) {
  const result = await connection.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise, userGesture },
    { sessionId },
  )
  if (result.exceptionDetails) {
    const details = result.exceptionDetails
    const text = details.exception?.description ?? details.text ?? 'page exception'
    throw new CdpError(String(text).split('\n')[0], FailureKind.Protocol)
  }
  return result.result?.value
}

/**
 * Describe what an evaluation returned, including the values that have no JSON
 * form.
 *
 * `Runtime.evaluate` reports those separately from `value`: `NaN` and
 * `Infinity` arrive as `unserializableValue`, a `BigInt` as `"123n"`, and a DOM
 * node as an empty object with a `subtype` and a class name. Dropping that
 * information turns all of them into `null` or `{}` — indistinguishable from a
 * genuine `null` or an empty object, so the caller cannot tell "the page
 * returned nothing" from "the page returned something that cannot be sent".
 */
export async function evaluateDescribed(connection, sessionId, expression, { awaitPromise = true } = {}) {
  const result = await connection.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise },
    { sessionId },
  )
  if (result.exceptionDetails) {
    const details = result.exceptionDetails
    const text = details.exception?.description ?? details.text ?? 'page exception'
    throw new CdpError(String(text).split('\n')[0], FailureKind.Protocol)
  }
  const remote = result.result ?? {}
  if (remote.unserializableValue !== undefined) {
    return { kind: 'unserializable', value: remote.unserializableValue, description: remote.description ?? null }
  }
  // Only a value that came back *without* a JSON form is described. Checking
  // `subtype` alone would be wrong: an array's RemoteObject carries
  // `subtype: 'array'` alongside a perfectly good `value`, so keying on subtype
  // would report every array as an opaque object and drop its contents.
  if (remote.value === undefined && (remote.subtype !== undefined || remote.className !== undefined)) {
    // A DOM node, a Date, a Map or a Set: no JSON form, but a description.
    return {
      kind: 'object',
      value: null,
      subtype: remote.subtype ?? null,
      description: remote.description ?? remote.className ?? null,
    }
  }
  return { kind: 'value', value: remote.value }
}

/**
 * Navigate a page and wait for load.
 *
 * A same-document navigation (e.g. a `#fragment` jump) never fires
 * `Page.loadEventFired`, so the wait expires and is swallowed on purpose —
 * the settle delay that follows is the fallback. The default timeout is kept
 * well below the old 30s because of exactly that case.
 *
 * The wait is scoped to this page's session. With persistent sessions every tab
 * shares the one socket, so an unscoped wait returns on whichever tab loaded
 * first — normally not the one being navigated.
 */
export async function navigate(connection, sessionId, url, { settleMs = 300, timeoutMs = 10000, signal } = {}) {
  const loaded = connection.once('Page.loadEventFired', timeoutMs, sessionId)
  // Observe the wait at creation, not only where it is awaited below. The two
  // exits above that await — `Page.navigate` rejecting, or resolving with
  // `errorText` — abandon this promise while its timer is still armed; the
  // rejection then arrives with no handler attached and Node terminates the
  // host process (unhandled rejections are fatal by default). Attaching a
  // no-op handler here makes the promise always observed; the real `await`
  // below still decides the outcome.
  loaded.catch(() => {})
  const result = await connection.send('Page.navigate', { url }, { sessionId })
  if (result?.errorText) {
    throw new CdpError(`navigation failed: ${result.errorText}`, FailureKind.Protocol)
  }
  try {
    await loaded
  } catch {
    // A same-document navigation may not fire the event; settle instead.
  }
  if (settleMs > 0) await sleep(settleMs, signal)
}

/**
 * Capture a PNG screenshot.
 *
 * Viewport by default. `fullPage: true` captures the whole document via
 * `captureBeyondViewport` + `clip`: the viewport is left untouched, so the
 * page does not re-lay-out — the old `Emulation.setDeviceMetricsOverride`
 * resize trick reflowed responsive pages and is gone for good.
 *
 * Two honest limits: content that only renders on scroll never entered the
 * compositor and is missing from the capture, and Chromium caps the capture
 * size — so both edges are clamped and the caller is told via `truncated`.
 *
 * @returns `{ png, truncated }`
 */
export async function screenshot(connection, sessionId, { fullPage = false, maxFullPageHeight = 8000, maxFullPageWidth = 8000 } = {}) {
  let clip
  let truncated = false
  if (fullPage) {
    const dims = await evaluate(
      connection,
      sessionId,
      `({ w: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
          h: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) })`,
    )
    // Undefined means the document went away between the two calls (a
    // navigation). Reading a field off it threw a TypeError that read like a
    // bug in the plugin rather than "there is no page to shoot".
    if (dims === null || dims === undefined) {
      throw new CdpError('the page has no measurable document — it may have navigated away', FailureKind.Protocol)
    }
    // A width over the capture limit makes Chromium refuse the whole call, so
    // an over-wide page would fail outright instead of returning a clamped shot.
    truncated = dims.h > maxFullPageHeight || dims.w > maxFullPageWidth
    clip = {
      x: 0,
      y: 0,
      width: Math.max(1, Math.min(dims.w, maxFullPageWidth)),
      height: Math.max(1, Math.min(dims.h, maxFullPageHeight)),
      scale: 1,
    }
  }
  const params = clip === undefined ? { format: 'png' } : { format: 'png', clip, captureBeyondViewport: true }
  const result = await connection.send('Page.captureScreenshot', params, { sessionId })
  if (!result?.data) throw new CdpError('screenshot returned no data', FailureKind.Protocol)
  return { png: Buffer.from(result.data, 'base64'), truncated }
}

/**
 * Dispatch a real click at viewport coordinates.
 *
 * Hover-before-click is deliberate: the move carries no button and no click
 * count, because a `mouseMoved` that reports a pressed button reads as a drag
 * to the page's own handlers and can leave a `:hover`-driven element in the
 * wrong state. Only the press and release carry the button.
 */
export async function clickAt(connection, sessionId, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', modifiers }, { sessionId })
  for (const type of ['mousePressed', 'mouseReleased']) {
    await connection.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, modifiers }, { sessionId })
  }
}

/**
 * Type text into the focused element.
 *
 * One key event pair per character, with `text` on the key-down — that is what
 * the renderer inserts. The unmodified `keyDown`/`keyUp` pair without `text`
 * merely reports a key press and types nothing, so the distinction matters.
 *
 * `key`, `code` and the virtual key code go with `text`, and that is what makes
 * the difference between "the character appears" and "the character is
 * accepted". A page that filters by `event.key` (numeric-only fields, OTP
 * boxes, editors with short-cuts) sees an empty `key` without them, calls
 * `preventDefault()`, and then the insertion never happens — while this
 * function would still report success because it never looks at the result.
 */
export async function typeText(connection, sessionId, text, { delayMs = 0 } = {}) {
  for (const char of text) {
    // A line break and a tab are keys with a default action, not characters:
    // sent as text they type a control code that no field accepts, and a page
    // that submits on `event.key === 'Enter'` never sees the key at all.
    if (char === '\n' || char === '\r') {
      await pressKey(connection, sessionId, 'Enter')
      if (delayMs > 0) await sleep(delayMs)
      continue
    }
    if (char === '\t') {
      await pressKey(connection, sessionId, 'Tab')
      if (delayMs > 0) await sleep(delayMs)
      continue
    }
    const described = describeChar(char)
    // Characters outside the BMP (most emoji) have no single UTF-16 unit to
    // carry in `text`, and the browser would insert U+FFFD. `Input.insertText`
    // is the faithful route for them: it inserts the string as composed text,
    // with no key event to attribute it to.
    if (described === null) {
      await connection.send('Input.insertText', { text: char }, { sessionId })
      if (delayMs > 0) await sleep(delayMs)
      continue
    }
    await connection.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        text: described.text,
        unmodifiedText: described.unmodifiedText,
        key: described.key,
        code: described.code,
        windowsVirtualKeyCode: described.keyCode,
        nativeVirtualKeyCode: described.keyCode,
      },
      { sessionId },
    )
    // The release carries no `text`: Chromium inserts nothing from a key-up,
    // and a real keyboard's release does not report a character either.
    await connection.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: described.key, code: described.code, windowsVirtualKeyCode: described.keyCode },
      { sessionId },
    )
    if (delayMs > 0) await sleep(delayMs)
  }
}

/**
 * The key fields for one typed character, or `null` when it cannot be typed as
 * a key at all.
 *
 * `key` and `unmodifiedText` are what a real keyboard reports, and they differ
 * from the character whenever it needs Shift: typing `H` produces
 * `key: 'H'`, `unmodifiedText: 'h'`, `modifiers: 8`. Sending the raw character
 * in all three fields describes a key no keyboard has, and the browser then
 * decides for itself what to insert.
 */
function describeChar(char) {
  const upper = char.toUpperCase()
  if (upper.length === 1 && upper >= 'A' && upper <= 'Z') {
    const shifted = char !== upper
    return {
      text: char,
      key: char,
      unmodifiedText: upper.toLowerCase(),
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      ...(shifted ? { modifiers: 8 } : {}),
    }
  }
  if (char >= '0' && char <= '9') {
    return { text: char, key: char, unmodifiedText: char, code: `Digit${char}`, keyCode: char.charCodeAt(0) }
  }
  // A surrogate half is not a character: sending it would insert a replacement
  // character while the command reported success.
  if (char.length !== 1 || char.codePointAt(0) > 0xffff) return null
  // Punctuation has layout-dependent codes; the key code still lets a page
  // match on it, and an empty `code` is what a browser reports when it has no
  // layout name for the key.
  return { text: char, key: char, code: '', keyCode: char.codePointAt(0) ?? 0 }
}

/**
 * Press one named key, optionally with modifiers held.
 *
 * Named keys are the ones with a default action — Enter submits, Tab moves
 * focus, Escape closes a popover, Backspace deletes. None of that is reachable
 * from `typeText`, which only sends `text` and therefore only inserts
 * characters; this is why a form could be filled but not submitted before.
 *
 * A key that produces no character (Tab, arrows, F-keys) is sent as
 * `rawKeyDown`: sending `keyDown` without `text` makes Chromium look for a
 * text-producing key and silently drop the default action.
 */
export async function pressKey(connection, sessionId, spec, { delayMs = 0 } = {}) {
  const { name, modifiers, held } = parseKeySpec(spec)
  if (MODIFIER_KEYS.has(name)) {
    // A bare modifier press: report it, then release, so the window sees the
    // press without leaving a modifier latched.
    const modifier = MODIFIER_BITS[name.toLowerCase()] ?? MODIFIER_BITS[name.replace(/^Control$/, 'ctrl').toLowerCase()]
    const key = name === 'Ctrl' ? 'Control' : name === 'Cmd' ? 'Meta' : name
    await connection.send(
      'Input.dispatchKeyEvent',
      { type: 'rawKeyDown', key, code: key, modifiers: modifier ?? 0, windowsVirtualKeyCode: modifierToKeyCode(modifier) },
      { sessionId },
    )
    await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, modifiers: 0 }, { sessionId })
    return { pressed: spec, modifiers: modifier ?? 0 }
  }
  const described = describeKey(name)
  // `key` is the character the key would produce *without* Ctrl or Alt, so
  // Shift alone leaves the case it was written in (Ctrl+Shift+A reports `A`)
  // and any other modifier reports the unshifted letter (`Ctrl+A` reports `a`,
  // as Chromium's own accelerators are matched). Sending `A` for Ctrl+A
  // describes a key that only exists with Shift held.
  const unshifted = described.key.length === 1 && /[A-Za-z]/.test(described.key)
    ? described.key.toLowerCase()
    : described.key
  const chordKey = modifiers & 0b110 ? unshifted : described.key
  // Shifted punctuation (`Shift+1` is `!` on a US layout) has no character in
  // the spec, so the unshifted digit stands in for it, as a real keyboard does.
  const chordText = modifiers === 8 ? undefined : described.text
  const common = {
    key: chordKey,
    code: described.code,
    modifiers,
    windowsVirtualKeyCode: described.keyCode,
    nativeVirtualKeyCode: described.keyCode,
  }
  // With a modifier held, the character is a command (Ctrl+A), not text: the
  // renderer must match the accelerator, so it is sent as a raw key down.
  //
  // `text` goes on the key-down only. Repeating it on key-up would make the
  // renderer insert the character a second time — key-up carries no text for a
  // real keyboard, and Chromium does not filter it out on its own.
  if (chordText !== undefined && modifiers === 0) {
    const event = { ...common, type: 'keyDown', text: chordText }
    // The protocol rejects `unmodifiedText` that is not a single character: it
    // is omitted for punctuation, which has no unshifted form here.
    if (unshifted.length === 1) event.unmodifiedText = unshifted
    await connection.send('Input.dispatchKeyEvent', event, { sessionId })
  } else {
    await connection.send('Input.dispatchKeyEvent', { ...common, type: 'rawKeyDown' }, { sessionId })
  }
  await connection.send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' }, { sessionId })
  if (delayMs > 0) await sleep(delayMs)
  return { pressed: spec, modifiers, held }
}

/** Windows virtual key codes for modifier-only events. */
function modifierToKeyCode(bit) {
  if (bit === 2) return 17 // Control
  if (bit === 8) return 16 // Shift
  if (bit === 1) return 18 // Alt
  if (bit === 4) return 91 // Meta
  return 0
}

/**
 * Build the CDP modifier bitmask from names.
 *
 * `click` and `drag` take modifiers as a list (`["ctrl","shift"]`) while keys
 * take them inside the spec (`"Ctrl+A"`); both end up as this one bitfield.
 */
export function modifierMask(names) {
  if (names === undefined || names === null) return 0
  const list = Array.isArray(names) ? names : [names]
  let mask = 0
  for (const name of list) {
    const bit = MODIFIER_BITS[String(name).toLowerCase()]
    if (bit === undefined) throw new CdpError(`unknown modifier "${name}"`, FailureKind.Protocol)
    mask |= bit
  }
  return mask
}

/**
 * Move the pointer over an element.
 *
 * The reason this cannot be a DOM event: CSS `:hover` is a browser-side state
 * driven by the real pointer, and `dispatchEvent(new MouseEvent('mouseover'))`
 * never sets it. Menus and tooltips that open on hover — which is most
 * navigation bars — therefore stay closed for a synthesized event.
 */
export async function hoverAt(connection, sessionId, x, y) {
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, { sessionId })
}

/**
 * Drag from one point to another.
 *
 * A real drag is a press, a series of moves, and a release. The intermediate
 * moves are what a drag handler reads: without them, `dragstart` fires with no
 * pointer motion and libraries that track velocity or a threshold (sortable
 * lists, sliders, canvas editors) treat it as a click.
 */
export async function dragBetween(connection, sessionId, from, to, { steps = 10, modifiers = 0 } = {}) {
  await connection.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', modifiers },
    { sessionId },
  )
  await connection.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, modifiers },
    { sessionId },
  )
  const count = Math.max(1, steps)
  for (let i = 1; i <= count; i += 1) {
    const x = from.x + ((to.x - from.x) * i) / count
    const y = from.y + ((to.y - from.y) * i) / count
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', modifiers }, { sessionId })
  }
  await connection.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, modifiers },
    { sessionId },
  )
}

/**
 * Scroll at a point, in CSS pixels.
 *
 * Two paths, because the protocol one is not enough on its own. The primary is
 * `Input.synthesizeScrollGesture`, which drives Chromium's own scroll pipeline
 * and therefore produces real `wheel` events — what custom scroll containers
 * and scroll-linked animations listen for. The reason it cannot be the only
 * path: a synthesized gesture is routed through the compositor, and a tab that
 * is not the foreground tab (or has just lost focus) accepts the command, moves
 * nothing, and fires no events at all. That failure is silent, so the result is
 * measured rather than trusted, and a gesture that moved nothing falls back to
 * scrolling in the page.
 *
 * The fallback dispatches a real `WheelEvent` and then performs the scroll
 * itself only when nothing cancelled it, so a listener that calls
 * `preventDefault()` still wins — the behaviour is the browser's, not a
 * straight `scrollTop` assignment.
 *
 * Signs are inverted between the two APIs: `deltaY > 0` means "scroll down"
 * while a *negative* `yDistance` does. Callers keep the familiar delta form
 * (positive down, positive right); the inversion happens here.
 */
export async function wheelAt(connection, sessionId, x, y, deltaX, deltaY) {
  const dx = Math.round(deltaX)
  const dy = Math.round(deltaY)
  const wantX = dx !== 0
  const wantY = dy !== 0

  /**
   * Where the scroll would land, split per axis.
   *
   * Both axes are probed independently. A container can scroll horizontally and
   * not vertically (`overflow-x: auto; overflow-y: hidden`), and a vertical-only
   * probe reports "not scrollable" for it — the gesture then moves it while the
   * probe sees nothing, the fallback runs too, and one call scrolls two
   * different containers. The axes also have to be compared separately for the
   * same reason: a horizontal move satisfies "something changed" and would
   * suppress the fallback on the axis that did not move.
   */
  const measure = `(() => {
    const point = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    let node = point;
    let containerX = null;
    let containerY = null;
    while (node !== null && node !== undefined) {
      const style = getComputedStyle(node);
      if (containerX === null && /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth) containerX = node;
      if (containerY === null && /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) containerY = node;
      node = node.parentElement;
    }
    return {
      x: containerX === null ? window.scrollX : containerX.scrollLeft,
      y: containerY === null ? window.scrollY : containerY.scrollTop,
      hasContainerX: containerX !== null,
      hasContainerY: containerY !== null,
    };
  })()`

  const before = await evaluate(connection, sessionId, measure)
  try {
    await connection.send(
      'Input.synthesizeScrollGesture',
      {
        x: Math.round(x),
        y: Math.round(y),
        xDistance: -dx,
        yDistance: -dy,
        gestureSourceType: 'mouse',
        // Fast enough that a 600px scroll takes ~200ms instead of the ~850ms
        // the default gesture speed needs, slow enough to stay a gesture.
        speed: 4000,
      },
      { sessionId, timeoutMs: 15_000 },
    )
  } catch {
    // A gesture that never answers is one of the documented failures; the
    // page-level path below still has to run.
  }

  // A smooth or inertial scroll is still moving when the gesture answers, so
  // the measurement waits two frames: reading immediately reported "nothing
  // moved" for a scroll that was about to happen, and the fallback then scrolled
  // the page a second time.
  await evaluate(
    connection,
    sessionId,
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))',
  )
  const after = await evaluate(connection, sessionId, measure)
  const movedX = wantX ? Math.abs((after?.x ?? 0) - (before?.x ?? 0)) : 0
  const movedY = wantY ? Math.abs((after?.y ?? 0) - (before?.y ?? 0)) : 0
  // Every requested axis must have moved. A gesture that moved one of two
  // requested axes is a partial failure, and the fallback is what completes it.
  const shortX = wantX && movedX === 0
  const shortY = wantY && movedY === 0
  if (!shortX && !shortY) return { scrolled: { deltaX: dx, deltaY: dy }, via: 'gesture' }

  // Each axis is dispatched to the element that axis scrolls, so a listener on
  // that container receives the event the same call then acts on. One event
  // aimed at the vertical container used to carry the horizontal delta too,
  // reaching a listener that has no part in the horizontal scroll.
  const result = await evaluate(
    connection,
    sessionId,
    `(() => {
       const point = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
       let node = point;
       let containerX = null;
       let containerY = null;
       while (node !== null && node !== undefined) {
         const style = getComputedStyle(node);
         if (containerX === null && /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth) containerX = node;
         if (containerY === null && /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) containerY = node;
         node = node.parentElement;
       }
       const scrollTarget = document.scrollingElement ?? document.documentElement;
       const fire = (dx, dy, target) => {
         const event = new WheelEvent('wheel', {
           bubbles: true, cancelable: true, deltaX: dx, deltaY: dy, deltaMode: 0,
           clientX: ${Math.round(x)}, clientY: ${Math.round(y)},
         });
         return (target ?? point ?? scrollTarget).dispatchEvent(event) === false;
       };
       let cancelledByPage = false;
       // Only the axis the gesture failed to move is compensated here, so a
       // half-done gesture is completed instead of re-scrolling the axis that
       // already worked.
       if (${shortY}) {
         const target = containerY ?? scrollTarget;
         if (fire(0, ${dy}, target)) cancelledByPage = true;
         else if (containerY !== null) containerY.scrollTop += ${dy};
         else window.scrollBy(0, ${dy});
       }
       if (${shortX}) {
         const target = containerX ?? scrollTarget;
         if (fire(${dx}, 0, target)) cancelledByPage = true;
         else if (containerX !== null) containerX.scrollLeft += ${dx};
         else window.scrollBy(${dx}, 0);
       }
       return { cancelledByPage };
     })()`,
  )
  return {
    scrolled: { deltaX: dx, deltaY: dy },
    via: shortX && shortY ? 'page' : 'page-partial',
    cancelledByPage: result?.cancelledByPage === true,
  }
}

/**
 * Set a `<select>`'s value and fire the events a user's choice would.
 *
 * The dropdown itself is browser chrome — it is not in the page's DOM, so no
 * script can open it and no synthetic event can pick from it. Setting `value`
 * and dispatching `input` + `change` is what the browser does to the page after
 * a real pick, and it is what every form library listens for. The one thing it
 * skips is `focus`/`blur`, which browsers fire on a real interaction.
 */
export async function selectOption(connection, sessionId, { selector, values, byLabel = false }) {
  const list = (Array.isArray(values) ? values : [values]).map((value) => String(value))
  // An empty list would otherwise select nothing and report success with an
  // empty `picked`, which reads exactly like "the option was not found".
  if (list.length === 0) throw new CdpError('select needs at least one value', FailureKind.Protocol)
  const result = await evaluate(
    connection,
    sessionId,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) return { error: 'no element matches ' + ${JSON.stringify(selector)} };
       const tag = el.tagName.toLowerCase();
       if (tag !== 'select') return { error: 'not a <select> element (it is <' + tag + '>)' };
       const wanted = ${JSON.stringify(list)};
       const options = [...el.options];
       const picked = [];
       const pick = (want) => ${byLabel}
         ? options.find((o) => o.label === want || (o.text || '').trim() === want)
         : options.find((o) => o.value === want);
       if (el.multiple === true) {
         for (const option of options) option.selected = false;
         for (const want of wanted) {
           const option = pick(want);
           if (option !== undefined) { option.selected = true; picked.push(option.value); }
         }
       } else {
         const option = pick(wanted[0]);
         if (option === undefined) {
           return { error: 'no option matching ' + JSON.stringify(wanted[0]), available: options.slice(0, 30).map((o) => ({ value: o.value, label: o.label })) };
         }
         el.value = option.value;
         picked.push(option.value);
       }
       // A real pick fires both; a library may listen for only one of them.
       el.dispatchEvent(new Event('input', { bubbles: true }));
       el.dispatchEvent(new Event('change', { bubbles: true }));
       return { value: el.multiple ? picked : el.value, picked, selectedCount: picked.length };
     })()`,
  )
  if (result?.error !== undefined) {
    const error = new CdpError(result.error, FailureKind.Protocol)
    if (Array.isArray(result.available)) error.available = result.available
    throw error
  }
  return result
}

/**
 * Give a file chooser the listed files.
 *
 * Two steps, and both are required: the dialog must be intercepted before the
 * click (otherwise the browser opens a native picker that no protocol call can
 * reach and the page waits forever), and then `DOM.setFileInputFiles` fills the
 * input with real files by path. This is the only way to attach a file at all —
 * page JS can build a `File` from bytes it already has, but it cannot read a
 * path from disk.
 */
export async function setFileInput(connection, sessionId, { selector, files }) {
  const doc = await connection.send('DOM.getDocument', { depth: 0 }, { sessionId })
  const { nodeId } = await connection.send(
    'DOM.querySelector',
    { nodeId: doc.root.nodeId, selector },
    { sessionId },
  )
  if (nodeId === 0 || nodeId === undefined) throw new CdpError(`no element matches ${selector}`, FailureKind.Protocol)
  await connection.send('DOM.setFileInputFiles', { nodeId, files }, { sessionId })
  return { selector, files }
}

/**
 * Wait for a condition, text, or selector, polling in the page.
 *
 * Polling in the page rather than in Node means one round trip per wait
 * instead of one per check, and the page's own event loop sees the change as
 * soon as it happens. The previous approach — a fixed `settleMs` — made every
 * command a guess, which is why an agent that had to wait for a spinner had no
 * choice but to retry until it happened to be fast enough.
 */
/**
 * Longest a `wait` may block by default.
 *
 * Kept below the connection's per-call deadline (`CALL_TIMEOUT_MS`, 10s in the
 * host). The wait is a single `Runtime.evaluate` whose script polls until its
 * own deadline, so a wait budget at or above the call deadline can never reach
 * its own timeout: the call is killed first and the caller gets
 * "Runtime.evaluate timed out after 10000ms" instead of the `ok:false` the
 * command promises. The gap covers the round trip.
 */
export const WAIT_BUDGET_MS = 8_000
/** Extra time the evaluate call is allowed beyond its own wait budget. */
const WAIT_CALL_SLACK_MS = 1_500

export async function waitFor(connection, sessionId, { text, textGone, selector, gone, expression, timeoutMs = WAIT_BUDGET_MS, pollMs = 100 }) {
  const conditions = []
  // Every field is checked for emptiness, not just for being a string: an empty
  // selector would compile to `querySelector("") !== null`, which is always
  // true, and the wait would report success on a page where nothing was found.
  const present = (value) => typeof value === 'string' && value !== ''
  if (present(text)) conditions.push(`document.body !== null && document.body.innerText.includes(${JSON.stringify(text)})`)
  // "Gone" has to mean "was there and is not any more". Before the document has
  // parsed a body every text is trivially absent, so the bare negation would
  // report success on a page that has not even loaded — the wait then answers
  // before the thing it is watching for ever appeared.
  if (present(textGone)) {
    conditions.push(`document.readyState !== 'loading' && (document.body === null || !document.body.innerText.includes(${JSON.stringify(textGone)}))`)
  }
  if (present(selector) && gone !== true) conditions.push(`document.querySelector(${JSON.stringify(selector)}) !== null`)
  if (present(selector) && gone === true) conditions.push(`document.querySelector(${JSON.stringify(selector)}) === null`)
  if (present(expression)) conditions.push(`Boolean(${expression})`)
  if (conditions.length === 0) throw new CdpError('wait needs one of: text, textGone, selector (+ gone), expression', FailureKind.Protocol)
  const combined = conditions.map((c) => `(${c})`).join(' && ')
  const budget = Math.max(1, Math.round(timeoutMs))
  // Node-side clock as well as the page's: the page's `waitedMs` measures only
  // its own polling loop, while `elapsedMs` covers the round trip too. Both are
  // reported because a large difference between them means the delay was in the
  // transport, not the page.
  const startedAt = Date.now()
  // The call deadline is widened past the in-page budget. Without it the
  // connection's default per-call timeout fires first and the caller sees a
  // protocol failure where this command is documented to answer `ok: false` —
  // and no budget above that default would ever work.
  const reply = await connection.send(
    'Runtime.evaluate',
    {
      expression: `(async () => {
       const started = Date.now();
       const deadline = started + ${budget};
       const check = () => { try { return ${combined}; } catch (e) { return false; } };
       if (check()) return { ok: true, waitedMs: 0 };
       while (Date.now() < deadline) {
         await new Promise((r) => setTimeout(r, ${Math.max(20, Math.round(pollMs))}));
         if (check()) return { ok: true, waitedMs: Date.now() - started };
       }
       return { ok: false, waitedMs: Date.now() - started };
     })()`,
      returnByValue: true,
      awaitPromise: true,
    },
    { sessionId, timeoutMs: budget + WAIT_CALL_SLACK_MS },
  )
  if (reply?.exceptionDetails !== undefined) {
    const details = reply.exceptionDetails
    throw new CdpError(
      String(details.exception?.description ?? details.text ?? 'wait expression threw').split('\n')[0],
      FailureKind.Protocol,
    )
  }
  const result = reply.result?.value
  return { ...result, elapsedMs: Date.now() - startedAt }
}

/**
 * Override the viewport size for this session.
 *
 * `Emulation.setDeviceMetricsOverride` is per-session state, so it evaporates
 * with the session and never leaks into the user's own view of the tab. That
 * property is what makes responsive checks safe here at all: without it, the
 * only way to see a page at 375px would be to resize the user's window.
 */
export async function resizeViewport(connection, sessionId, width, height, { deviceScaleFactor = 1, mobile = false } = {}) {
  if (width === null || width === undefined) {
    await connection.send('Emulation.clearDeviceMetricsOverride', {}, { sessionId })
    return { cleared: true }
  }
  await connection.send(
    'Emulation.setDeviceMetricsOverride',
    { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), deviceScaleFactor, mobile },
    { sessionId },
  )
  return { width, height, deviceScaleFactor, mobile }
}

/**
 * Emulate CSS media features (dark mode, reduced motion, print).
 *
 * The values are the CSS media feature names, so this covers both the
 * `prefers-color-scheme` checks that change how a page paints and
 * `Emulation.setEmulatedMedia({ media: 'print' })`, which is how a print
 * stylesheet is inspected without printing anything.
 *
 * Values are checked against the feature's own vocabulary. An unrecognised
 * value does not fail in the browser — it is accepted and simply never matches,
 * so a typo (`darck`) would look like "the dark styles are broken" rather than
 * "the value was wrong".
 */
const MEDIA_VALUES = {
  'prefers-color-scheme': ['light', 'dark'],
  'prefers-reduced-motion': ['no-preference', 'reduce'],
  'forced-colors': ['none', 'active'],
  'prefers-contrast': ['no-preference', 'more', 'less', 'custom'],
}
const MEDIA_TYPES = ['screen', 'print']

function mediaFeature(name, value) {
  if (value === undefined || value === null) return null
  const allowed = MEDIA_VALUES[name]
  if (!allowed.includes(value)) {
    throw new CdpError(
      `${name} does not accept "${value}" — use one of: ${allowed.join(', ')}`,
      FailureKind.Protocol,
    )
  }
  return { name, value }
}

export async function emulateMedia(connection, sessionId, { colorScheme, reducedMotion, forcedColors, contrast, media }) {
  const features = [
    mediaFeature('prefers-color-scheme', colorScheme),
    mediaFeature('prefers-reduced-motion', reducedMotion),
    mediaFeature('forced-colors', forcedColors),
    mediaFeature('prefers-contrast', contrast),
  ].filter((feature) => feature !== null)
  if (media !== undefined && media !== null && !MEDIA_TYPES.includes(media)) {
    throw new CdpError(`media does not accept "${media}" — use one of: ${MEDIA_TYPES.join(', ')}`, FailureKind.Protocol)
  }
  const params = {}
  if (features.length > 0) params.features = features
  if (media !== undefined && media !== null) params.media = media
  await connection.send('Emulation.setEmulatedMedia', params, { sessionId })
  return { colorScheme: colorScheme ?? null, reducedMotion: reducedMotion ?? null, forcedColors: forcedColors ?? null, contrast: contrast ?? null, media: media ?? null }
}

/**
 * Go back (or forward) in the tab's session history.
 *
 * `Page.navigateToHistoryEntry` is used rather than `history.back()` because
 * the protocol call reports the resulting entry and, crucially, the wait for
 * `Page.loadEventFired` is attached to the right session. In-page
 * `history.back()` returns immediately and gives no completion signal at all.
 */
export async function navigateHistory(connection, sessionId, delta) {
  const { currentIndex, entries } = await connection.send('Page.getNavigationHistory', {}, { sessionId })
  const target = currentIndex + delta
  if (target < 0 || entries === undefined || target >= entries.length) {
    throw new CdpError(
      delta < 0 ? 'no previous page in this tab\'s history' : 'no next page in this tab\'s history',
      FailureKind.Protocol,
    )
  }
  const entry = entries[target]
  const loaded = connection.once('Page.loadEventFired', 10_000, sessionId)
  loaded.catch(() => {})
  await connection.send('Page.navigateToHistoryEntry', { entryId: entry.id }, { sessionId })
  try {
    await loaded
  } catch {
    // A same-document history entry fires no load event.
  }
  return { url: entry.url, id: entry.id }
}

/** Raise a tab to the front so its rendering is not throttled. */
export async function bringToFront(connection, sessionId) {
  await connection.send('Page.bringToFront', {}, { sessionId })
}

// ---------------------------------------------------------------------------
// PNG decoding (the subset Chromium screenshots use) and colour checks
// ---------------------------------------------------------------------------

/** Largest image the decoder will expand. */
const MAX_DECODE_PIXELS = 64_000_000

/** Decode an 8-bit RGB/RGBA PNG into `{ width, height, data }` (RGBA bytes). */
export function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new CdpError('not a PNG buffer', FailureKind.Protocol)
  }
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  const chunks = []
  for (;;) {
    if (pos + 8 > buffer.length) throw new CdpError('truncated PNG', FailureKind.Protocol)
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      // The size arrives before the pixels do, so the limit is checked here:
      // allocating from a header alone would let a small file exhaust memory.
      if (width * height > MAX_DECODE_PIXELS) {
        throw new CdpError(`PNG is too large to decode (${width}x${height}, limit ${MAX_DECODE_PIXELS} pixels)`, FailureKind.Protocol)
      }
    } else if (type === 'IDAT') {
      chunks.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + length
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new CdpError(`unsupported PNG (bitDepth=${bitDepth}, colorType=${colorType})`, FailureKind.Protocol)
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  // Short scanlines used to decode silently: a missing filter byte indexed as
  // `undefined`, the row was zero-filled, and every pixel from there on read as
  // black — a truncated image that looked like a black page.
  if (raw.length < height * (stride + 1)) {
    throw new CdpError(`truncated PNG (${raw.length} of ${height * (stride + 1)} scanline bytes)`, FailureKind.Protocol)
  }
  const out = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset]
    offset += 1
    const line = Buffer.from(raw.subarray(offset, offset + stride))
    offset += stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? line[x - bpp] : 0
      const b = previous[x]
      const c = x >= bpp ? previous[x - bpp] : 0
      let value = line[x]
      if (filter === 1) value = (value + a) & 0xff
      else if (filter === 2) value = (value + b) & 0xff
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        // Paeth: pick whichever of left/above/upper-left is CLOSEST to the
        // linear prediction a+b-c. The choice is the *smallest* of the three
        // distances, so every comparison here is `<=` and the first branch that
        // wins takes it. Reversing these (picking the largest residual) still
        // produces a plausible-looking image while corrupting every pixel on
        // any row that uses this filter — which is the row type Chromium emits
        // for most screenshots, so pixel assertions would silently read the
        // wrong colour.
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        let pr = a
        if (pa <= pb && pa <= pc) pr = a
        else if (pb <= pc) pr = b
        else pr = c
        value = (value + pr) & 0xff
      }
      line[x] = value
    }
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4
      out[target] = line[x * bpp]
      out[target + 1] = line[x * bpp + 1]
      out[target + 2] = line[x * bpp + 2]
      out[target + 3] = colorType === 6 ? line[x * bpp + 3] : 255
    }
    previous = line
  }
  return { width, height, data: out }
}

/** Parse `#rgb`, `#rrggbb`, `rgb(...)`, or `[r,g,b]` into a triple. */
export function parseColor(spec) {
  if (Array.isArray(spec)) {
    const [r, g, b] = spec.map(Number)
    if ([r, g, b].some((n) => !Number.isFinite(n))) throw new Error(`bad colour ${JSON.stringify(spec)}`)
    return [r, g, b]
  }
  const text = String(spec).trim()
  const hex = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(text)
  if (hex) {
    const full = hex[1].length === 3 ? hex[1].split('').map((ch) => ch + ch).join('') : hex[1]
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
  }
  const fn = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text)
  if (fn) return [fn[1], fn[2], fn[3]].map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))))
  throw new Error(`bad colour "${spec}": use #rrggbb, #rgb, rgb(r,g,b) or [r,g,b]`)
}

/**
 * Sample a pixel; coordinates in 0..1 are relative to the image size.
 *
 * Non-numeric coordinates are refused rather than coerced. `Math.round(undefined)`
 * is `NaN`, which indexes the buffer as `undefined` and yields
 * `[undefined, undefined, undefined]` — a check that then compares against
 * `rgb(255, 0, 0)` and fails for a reason that has nothing to do with the
 * page's colour. A missing coordinate is a mistake in the request, and it says
 * so.
 */
export function samplePixel(image, x, y) {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new CdpError(`pixel check needs numeric x and y (got x=${JSON.stringify(x)}, y=${JSON.stringify(y)})`, FailureKind.Protocol)
  }
  const px = Math.min(image.width - 1, Math.max(0, x <= 1 ? Math.round(x * (image.width - 1)) : Math.round(x)))
  const py = Math.min(image.height - 1, Math.max(0, y <= 1 ? Math.round(y * (image.height - 1)) : Math.round(y)))
  const offset = (py * image.width + px) * 4
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]]
}

export function nearColor(a, b, tolerance = 16) {
  return (
    Math.abs(a[0] - b[0]) <= tolerance &&
    Math.abs(a[1] - b[1]) <= tolerance &&
    Math.abs(a[2] - b[2]) <= tolerance
  )
}

// ---------------------------------------------------------------------------
// Assertion runner
// ---------------------------------------------------------------------------

/** Clip a value for display so a large page value cannot flood the agent. */
function clip(value, max = 240) {
  if (value === null || value === undefined) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return null
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Check types `runChecks` executes. */
const CHECK_TYPES = new Set(['pixel', 'css', 'dom', 'js'])

/**
 * Run deterministic pixel/CSS/DOM/JS checks against a page and return a
 * pass/fail report. The screenshot is captured lazily at the first pixel
 * check and thrown away after any click, so a pixel check always sees the
 * page as it stands at that point in the sequence, never the pre-click image.
 *
 * `pageSession` is optional and only needed by checks that name their target
 * with a `ref` instead of a selector: a ref resolves through the protocol, not
 * through an expression. `connection`/`sessionId` remain the primary way to run
 * a check because they are what the pure checks use, and threading a session
 * through all of them would change nothing about how they evaluate.
 */
export async function runChecks(connection, sessionId, checks, { signal, pageSession } = {}) {
  const results = []
  let cachedShot = null
  const ensureShot = async () => {
    if (cachedShot === null) {
      const { png } = await screenshot(connection, sessionId)
      cachedShot = decodePng(png)
    }
    return cachedShot
  }

  /** Click whatever a check names, by coordinates, selector, or ref. */
  const clickTarget = async (click) => {
    if (click === null || click === undefined) return false
    if (typeof click === 'string') {
      await clickSelector(connection, sessionId, click)
      return true
    }
    // Coordinates are resolvable through the same point test a selector uses:
    // a synthetic MouseEvent is heard by nothing that listens for real input,
    // so a check carrying `click: {x, y}` has to go through `Input.dispatchMouseEvent`.
    if (typeof click.x === 'number' && typeof click.y === 'number') {
      const point = await evaluate(connection, sessionId, `(${POINT_AT_FN})(${click.x}, ${click.y})`)
      if (point === null || point === undefined) {
        throw new CdpError(`no element at ${click.x}, ${click.y}`, FailureKind.Protocol)
      }
      await dispatchPoint(connection, sessionId, point, {}, `${click.x},${click.y}`)
      return true
    }
    if (typeof click.ref === 'string' && click.ref !== '') {
      if (pageSession === undefined || pageSession === null) {
        throw new CdpError('a click with `ref` needs an attached page session', FailureKind.Protocol)
      }
      const point = await pageSession.pointFor({ ref: click.ref })
      await dispatchPoint(connection, sessionId, point, {
        domClick: async () => {
          await pageSession.withRefObject(click.ref, (objectId) =>
            pageSession.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function () { this.click() }' }),
          )
        },
      }, `ref=${click.ref}`)
      return true
    }
    if (typeof click.selector === 'string') {
      await clickSelector(connection, sessionId, click.selector)
      return true
    }
    return false
  }

  for (const raw of checks) {
    const check = { name: '', type: 'js', ...raw }
    const started = Date.now()
    try {
      // An unknown `type` used to fall through to the JS branch, so a typo
      // ("pixell", "css ") silently ran the check as an expression and the
      // report said "failed" instead of "this check is malformed".
      if (!CHECK_TYPES.has(check.type)) {
        throw new CdpError(`unknown check type "${check.type}" — use one of: pixel, css, dom, js`, FailureKind.Protocol)
      }
      if (check.click !== undefined && check.click !== null) {
        await clickTarget(check.click)
        // A click can change what the page renders: any pixel check after it
        // must re-capture, or it would assert against the pre-click image.
        cachedShot = null
        await sleep(check.waitMs ?? 150, signal)
      } else if (check.waitMs) {
        await sleep(check.waitMs, signal)
      }

      let ok = false
      let expected = null
      let actual = null

      if (check.type === 'pixel') {
        const image = await ensureShot()
        const got = samplePixel(image, check.x, check.y)
        const want = parseColor(check.color)
        ok = nearColor(got, want, check.tolerance ?? 16)
        expected = `≈rgb(${want.join(', ')})`
        actual = `rgb(${got.join(', ')})`
      } else if (check.type === 'css') {
        actual = await evaluate(
          connection,
          sessionId,
          `(() => { const el = document.querySelector(${JSON.stringify(check.selector)});
             return el === null ? null : getComputedStyle(el)[${JSON.stringify(check.property)}] })()`,
        )
        actual = actual === null || actual === undefined ? null : String(actual)
        if ('equals' in check) {
          expected = String(check.equals)
          ok = actual === expected
        } else if (check.matches !== undefined) {
          expected = `matches /${check.matches}/`
          ok = new RegExp(check.matches).test(actual ?? '')
        } else if (check.contains !== undefined) {
          expected = `contains "${check.contains}"`
          ok = (actual ?? '').includes(check.contains)
        } else {
          // Without a comparison this check only proves the element exists, so
          // it asks exactly that: an unset custom property reads as an empty
          // string, which the old `actual !== null` test counted as a pass.
          expected = 'element exists'
          ok = await evaluate(connection, sessionId, `document.querySelector(${JSON.stringify(check.selector)}) !== null`)
        }
      } else if (check.type === 'dom') {
        const present = await evaluate(
          connection,
          sessionId,
          `document.querySelector(${JSON.stringify(check.selector)}) !== null`,
        )
        if (check.absent === true) {
          expected = 'selector matches nothing'
          ok = present !== true
        } else if (check.text !== undefined) {
          // One round trip decides both parts: the element that was matched is
          // the element whose text is reported, so a re-render between two
          // queries cannot make the result describe a different node.
          const text = await evaluate(
            connection,
            sessionId,
            `(() => { const els = [...document.querySelectorAll(${JSON.stringify(check.selector)})];
               const hit = els.find((el) => (el.textContent ?? '').includes(${JSON.stringify(check.text)}));
               return hit === undefined ? null : (hit.textContent ?? '').trim() })()`,
          )
          expected = `some match contains "${check.text}"`
          actual = clip(text)
          ok = text !== null
        } else {
          expected = 'selector matches'
          ok = present === true
        }
      } else {
        if (typeof check.expression !== 'string' || check.expression === '') {
          throw new CdpError('a js check needs an expression', FailureKind.Protocol)
        }
        const value = await evaluate(connection, sessionId, check.expression)
        actual = clip(value)
        if ('equals' in check) {
          ok = JSON.stringify(value) === JSON.stringify(check.equals)
          expected = clip(check.equals)
        } else {
          ok = Boolean(value)
          expected = 'truthy'
        }
      }
      results.push({ name: check.name, type: check.type, ok, expected, actual, ms: Date.now() - started })
    } catch (error) {
      results.push({
        name: check.name,
        type: check.type,
        ok: false,
        expected: null,
        actual: null,
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - started,
      })
    }
  }

  return results
}

/**
 * Click the element matching a selector with a real input event.
 *
 * A DOM `.click()` only runs the click handler — components listening for
 * pointer/mouse events (common in UI libraries, drag targets, editors) never
 * see it, and the caller reports success on a page where nothing happened.
 * So the element is scrolled into view and clicked at its centre via
 * `Input.dispatchMouseEvent`, the same path `clickAt` and a real user take.
 * Elements with no box (zero width/height) have no coordinates to dispatch to
 * and fall back to a DOM click; an element covered by another one is reported
 * instead of silently clicking the covering element.
 */
export async function clickSelector(connection, sessionId, selector, options = {}) {
  const info = await evaluate(connection, sessionId, `(${POINT_FN}).call(document.querySelector(${JSON.stringify(selector)}))`)
  if (info === null || info === undefined) throw new CdpError(`no element matches ${selector}`, FailureKind.Protocol)
  return dispatchPoint(connection, sessionId, info, {
    ...options,
    domClick: () => evaluate(connection, sessionId, `document.querySelector(${JSON.stringify(selector)}).click()`),
  }, selector)
}

/**
 * Turn a measured point into the action it implies.
 *
 * Shared by click, hover, and drag so the three answer the same way: a
 * zero-box element has no coordinates (fall back to the DOM click), and a
 * covered element is reported rather than silently acting on whatever is on top.
 *
 * `domClick` is the caller's way to say how to reach the element without
 * coordinates — a selector or a resolved object handle. It is a callback rather
 * than an argument because the two are resolved differently (one in the page by
 * selector, one through the protocol by ref) and the point test is the only
 * part they share.
 */
export async function dispatchPoint(connection, sessionId, point, options = {}, label = '') {
  const { button = 'left', clickCount = 1, modifiers = 0, hoverOnly = false, domClick } = options
  const what = label === '' ? 'element' : label
  if (point.dom === true) {
    if (hoverOnly === true) return { hovered: what, dom: true }
    // A zero-box element has no coordinates to dispatch to; the DOM click is
    // the only reachable path. It runs the click handler but not the pointer
    // chain — which is exactly the trade the caller accepted by clicking a
    // hidden element.
    if (typeof domClick === 'function') await domClick()
    return { clicked: what, dom: true }
  }
  if (point.covered === true) {
    throw new CdpError(
      `${what} is covered by another element — scroll it into view or click by coordinates instead`,
      FailureKind.Protocol,
    )
  }
  if (point.inViewport === false) {
    // The element has a box but sits outside the viewport, so there is no
    // reachable coordinate. Dispatching a click at a negative or off-screen
    // position reaches nothing, and the page's handler never runs — the
    // command would still report success.
    throw new CdpError(
      `${what} is outside the viewport (x=${Math.round(point.x)}, y=${Math.round(point.y)}) — bring it into view, or click by coordinates`,
      FailureKind.Protocol,
    )
  }
  if (hoverOnly === true) {
    await hoverAt(connection, sessionId, point.x, point.y)
    return { hovered: what, x: Math.round(point.x), y: Math.round(point.y) }
  }
  await clickAt(connection, sessionId, point.x, point.y, { button, clickCount, modifiers })
  return { clicked: what, x: Math.round(point.x), y: Math.round(point.y), button, clickCount }
}

/**
 * Build an aria snapshot in the page and register its refs on the session.
 *
 * Two things make this worth a protocol round trip over the DOM outline the
 * plugin already had. First, the accessibility tree survives markup churn: an
 * extra wrapper `div` changes every CSS path but not the role/name pair.
 * Second, `backendDOMNodeId` is a stable handle the protocol can resolve back to
 * a live node, which is what turns `ref` into something `click` can act on —
 * the previous outline could only be re-described as a selector by hand.
 */
export async function ariaSnapshot(pageSession, { limit = 120, withBoxes = false } = {}) {
  const { nodes } = await pageSession.send('Accessibility.getFullAXTree', {})
  if (!Array.isArray(nodes)) throw new CdpError('the browser returned no accessibility tree', FailureKind.Protocol)
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const cap = Math.min(limit, REF_LIMIT)

  // The tree is walked by `childIds` directly rather than materialised first.
  // Building a nested copy of the whole AX tree would recurse over every node
  // on the page — a large app runs to tens of thousands — before the `limit`
  // ever applies, which risks a stack overflow for a structure this function
  // only needs the first `cap` rows of.
  //
  // A node whose parent is absent from the returned set is a root. Chromium
  // sends the full tree in one call, but treating a missing parent as a root
  // keeps the walk defined if that ever changes.
  const roots = []
  for (const node of nodes) {
    if (node.parentId !== undefined && node.parentId !== null && byId.has(node.parentId)) continue
    roots.push(node)
  }

  const flat = []
  /**
   * `depth` is the output indentation (unchanged across skipped nodes); `hops`
   * is the real recursion depth and is what bounds the walk. Without the second
   * counter a long chain of skipped wrapper nodes — deeply nested `aria-hidden`
   * markup, which real apps do produce — would recurse without ever reaching
   * the `depth > 24` guard and could exhaust the stack.
   */
  const walk = (node, depth, hops) => {
    if (flat.length >= cap || hops > 200) return
    const role = node.role?.value ?? ''
    const name = node.name?.value ?? ''
    const ignored = node.ignored === true
    // An ignored node carries no semantics, but its children do: flatten rather
    // than drop, or an aria-hidden wrapper would hide a whole subtree.
    const skip = ignored || role === '' || role === 'generic' || role === 'InlineTextBox' || role === 'none'
    const refWorthy = !skip && node.backendDOMNodeId !== undefined && node.backendDOMNodeId !== null
    if (refWorthy) flat.push({ role, name: clipText(name, 160), backendDOMNodeId: node.backendDOMNodeId, depth })
    for (const id of node.childIds ?? []) {
      const child = byId.get(id)
      if (child !== undefined) walk(child, refWorthy ? depth + 1 : depth, hops + 1)
    }
  }
  for (const root of roots) walk(root, 0, 0)
  const withRefs = pageSession.setRefs(flat)
  let lines = withRefs.map((node) => `${'  '.repeat(node.depth)}- ${node.role}${node.name === '' ? '' : ` "${node.name}"`}${node.ref === null ? '' : ` [ref=${node.ref}]`}`)
  if (withBoxes === true) {
    const boxed = await Promise.all(
      withRefs.map(async (node) => {
        if (node.ref === null) return null
        try {
          return await pageSession.withRefObject(node.ref, async (objectId) => {
            const result = await pageSession.send('Runtime.callFunctionOn', {
              objectId,
              functionDeclaration: 'function () { const r = this.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }',
              returnByValue: true,
            })
            return result?.result?.value ?? null
          })
        } catch {
          return null
        }
      }),
    )
    lines = lines.map((line, i) => (boxed[i] === null ? line : `${line} {x:${boxed[i].x} y:${boxed[i].y} w:${boxed[i].w} h:${boxed[i].h}}`))
  }
  const { title, url, nodes: count } = await evaluate(
    pageSession.connection,
    pageSession.sessionId,
    `({ title: document.title, url: location.href, nodes: document.querySelectorAll('*').length })`,
  )
  return { title, url, nodes: count, refs: withRefs.length, truncated: flat.length >= Math.min(limit, REF_LIMIT), tree: lines.join('\n') }
}

/**
 * Test-only surface, following the convention `lib/index.js` set with its own
 * `__test`. Nothing here is part of the plugin contract.
 */
export const __test = { POINT_FN, POINT_AT_FN, describeKey, parseKeySpec, modifierMask }
