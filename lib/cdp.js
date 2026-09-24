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
  constructor(resolve, reject, timer) {
    this.resolve = resolve
    this.reject = reject
    this.timer = timer
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
  #closed = false
  #ready = false
  #attached = false
  #callTimeoutMs
  /**
   * Settles once the handshake completes. Created when the socket is built and
   * resolved by a *persistent* listener, so a late approval can never be missed:
   * the `open` event fires exactly once, and a poll that starts after it fires
   * would otherwise wait forever for an event that already happened.
   */
  #handshake = null

  constructor(url, { callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
    this.#url = url
    this.#callTimeoutMs = callTimeoutMs
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
    this.#ws.addEventListener('close', () => {
      this.#closed = true
      this.#ready = false
      this.#failAll(new CdpError('connection closed', FailureKind.Unreachable))
    })
    this.#ws.addEventListener('error', () => {
      this.#failAll(new CdpError('connection error', FailureKind.Unreachable))
    })
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
    const ws = new WebSocket(this.#url)
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
      this.#pending.set(id, new Pending(resolve, reject, timer))
    })
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

  /** Wait for one occurrence of a CDP event. */
  once(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params) => {
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

/** Attach a flattened session to one target, run `fn`, always detach. */
export async function withPage(connection, targetId, fn, options = {}) {
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await connection.send('Runtime.enable', {}, { sessionId })
    return await fn(sessionId)
  } finally {
    try {
      await connection.send('Target.detachFromTarget', { sessionId })
    } catch {
      // The target may already be gone; detaching is best-effort.
    }
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

/** Navigate a page and wait for load. */
export async function navigate(connection, sessionId, url, { settleMs = 300, timeoutMs = 30000, signal } = {}) {
  const loaded = connection.once('Page.loadEventFired', timeoutMs)
  await connection.send('Page.navigate', { url }, { sessionId })
  try {
    await loaded
  } catch {
    // A same-document navigation may not fire the event; settle instead.
  }
  if (settleMs > 0) await sleep(settleMs, signal)
}

/** Capture a PNG screenshot of a page. */
export async function screenshot(connection, sessionId, { fullPage = false } = {}) {
  if (fullPage) {
    const dims = await evaluate(
      connection,
      sessionId,
      `({ w: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
          h: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) })`,
    )
    await connection.send(
      'Emulation.setDeviceMetricsOverride',
      { width: Math.max(1, dims.w), height: Math.max(1, dims.h), deviceScaleFactor: 1, mobile: false },
      { sessionId },
    )
    try {
      return await capture(connection, sessionId)
    } finally {
      await connection.send('Emulation.clearDeviceMetricsOverride', {}, { sessionId }).catch(() => {})
    }
  }
  return capture(connection, sessionId)
}

async function capture(connection, sessionId) {
  const result = await connection.send('Page.captureScreenshot', { format: 'png' }, { sessionId })
  if (!result?.data) throw new CdpError('screenshot returned no data', FailureKind.Protocol)
  return Buffer.from(result.data, 'base64')
}

/** Dispatch a real click at viewport coordinates. */
export async function clickAt(connection, sessionId, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await connection.send(
      'Input.dispatchMouseEvent',
      { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 },
      { sessionId },
    )
  }
}

/** Type text into the focused element. */
export async function typeText(connection, sessionId, text) {
  for (const char of text) {
    await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char }, { sessionId })
    await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', text: char }, { sessionId })
  }
}

// ---------------------------------------------------------------------------
// PNG decoding (the subset Chromium screenshots use) and colour checks
// ---------------------------------------------------------------------------

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
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        let pr = a
        if (pc >= pa && pc >= pb) pr = c
        else if (pb >= pa) pr = b
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

/** Sample a pixel; coordinates in 0..1 are relative to the image size. */
export function samplePixel(image, x, y) {
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

/**
 * Run deterministic pixel/CSS/DOM/JS checks against a page and return a
 * pass/fail report. The screenshot is captured lazily at the first pixel check
 * so it reflects any clicks performed by earlier checks.
 */
export async function runChecks(connection, sessionId, checks, { signal } = {}) {
  const results = []
  let cachedShot = null
  const ensureShot = async () => {
    if (cachedShot === null) cachedShot = decodePng(await screenshot(connection, sessionId))
    return cachedShot
  }

  for (const raw of checks) {
    const check = { name: '', type: 'js', ...raw }
    const started = Date.now()
    try {
      if (check.click !== undefined && check.click !== null) {
        if (typeof check.click === 'string') {
          await clickSelector(connection, sessionId, check.click)
        } else if (typeof check.click.x === 'number' && typeof check.click.y === 'number') {
          await clickAt(connection, sessionId, check.click.x, check.click.y)
        } else if (typeof check.click.selector === 'string') {
          await clickSelector(connection, sessionId, check.click.selector)
        }
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
          expected = 'element exists'
          ok = actual !== null
        }
      } else if (check.type === 'dom') {
        actual = await evaluate(
          connection,
          sessionId,
          `(() => { const els = [...document.querySelectorAll(${JSON.stringify(check.selector)})];
             if (els.length === 0) return null;
             return true })()`,
        )
        const present = actual === true
        if (check.absent === true) {
          expected = 'selector matches nothing'
          ok = !present
        } else if (check.text !== undefined) {
          const text = await evaluate(
            connection,
            sessionId,
            `(() => { const els = [...document.querySelectorAll(${JSON.stringify(check.selector)})];
               const hit = els.find((el) => (el.textContent || '').includes(${JSON.stringify(check.text)}));
               return hit === undefined ? null : hit.textContent.trim() })()`,
          )
          expected = `some match contains "${check.text}"`
          actual = clip(text)
          ok = text !== null
        } else {
          expected = 'selector matches'
          ok = present
        }
      } else {
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

/** Click the element matching a selector, reporting a miss. */
async function clickSelector(connection, sessionId, selector) {
  const hit = await evaluate(
    connection,
    sessionId,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return false; el.click(); return true })()`,
  )
  if (hit !== true) throw new CdpError(`no element matches ${selector}`, FailureKind.Protocol)
}
