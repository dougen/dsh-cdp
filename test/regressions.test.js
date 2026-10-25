// Regressions found by the 0.4.0 review. Each one was a case where the
// command reported success while doing something other than what it said.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, parse } from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  CdpConnection,
  CdpError,
  PageSessions,
  decodePng,
  pressKey,
  samplePixel,
  typeText,
  wheelAt,
} from '../lib/cdp.js'

// --- a socket that records what was sent -----------------------------------

class FakeSocket {
  constructor() {
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
    this.responder = null
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  emit(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }

  open() {
    this.readyState = 1
    this.emit('open')
  }

  send(data) {
    const message = JSON.parse(data)
    this.sent.push(message)
    if (this.responder !== null) {
      const outcome = this.responder(message)
      queueMicrotask(() => this.reply(message.id, outcome))
    }
  }

  reply(id, result) {
    this.emit('message', { data: JSON.stringify({ id, result }) })
  }

  event(method, params, sessionId) {
    this.emit('message', { data: JSON.stringify({ method, params, sessionId }) })
  }

  close() {
    this.readyState = 3
    this.emit('close')
  }
}

async function connected(responder = () => ({})) {
  const socket = new FakeSocket()
  socket.responder = responder
  const connection = new CdpConnection('ws://x/devtools/browser/y', { callTimeoutMs: 1000, socketFactory: () => socket })
  const pending = connection.open({ timeoutMs: 500 })
  socket.open()
  await pending
  return { socket, connection }
}

// --- decodePng: the Paeth filter ------------------------------------------

/** A PNG whose second row uses filter 4 (Paeth). */
function paethPng() {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let table = null
  const crc32 = (buf) => {
    if (table === null) {
      table = new Uint32Array(256)
      for (let n = 0; n < 256; n += 1) {
        let c = n
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[n] = c >>> 0
      }
    }
    let crc = 0xffffffff
    for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(8 + data.length + 4)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'ascii')
    data.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }

  const width = 3
  const height = 3
  const bpp = 4
  const pixels = [
    [[10, 20, 30, 255], [200, 100, 50, 255], [7, 8, 9, 255]],
    [[11, 21, 31, 255], [201, 101, 51, 255], [8, 9, 10, 255]],
    [[12, 22, 32, 255], [202, 102, 52, 255], [9, 10, 11, 255]],
  ]
  const paeth = (a, b, c) => {
    const pa = Math.abs(b - c)
    const pb = Math.abs(a - c)
    const pc = Math.abs(a + b - 2 * c)
    if (pa <= pb && pa <= pc) return a
    if (pb <= pc) return b
    return c
  }
  const raw = []
  let previous = Buffer.alloc(width * bpp)
  for (let y = 0; y < height; y += 1) {
    const line = Buffer.alloc(width * bpp)
    for (let x = 0; x < width; x += 1) {
      const p = pixels[y][x]
      line[x * 4] = p[0]
      line[x * 4 + 1] = p[1]
      line[x * 4 + 2] = p[2]
      line[x * 4 + 3] = p[3]
    }
    const filter = y === 1 ? 4 : 0
    const encoded = Buffer.alloc(width * bpp)
    for (let x = 0; x < width * bpp; x += 1) {
      const a = x >= bpp ? line[x - bpp] : 0
      const b = previous[x]
      const c = x >= bpp ? previous[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v = (v - a) & 0xff
      else if (filter === 2) v = (v - b) & 0xff
      else if (filter === 3) v = (v - ((a + b) >> 1)) & 0xff
      else if (filter === 4) v = (v - paeth(a, b, c)) & 0xff
      encoded[x] = v
    }
    raw.push(Buffer.from([filter]), encoded)
    previous = line
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('decodePng decodes a Paeth-filtered row to the original pixels', () => {
  // Regression: the Paeth branch picked the *largest* residual instead of the
  // smallest. Every row Chromium encodes with filter 4 came out corrupted,
  // which silently broke every pixel assertion.
  const image = decodePng(paethPng())
  const row = (y) => {
    const out = []
    for (let x = 0; x < 3; x += 1) {
      const o = (y * 3 + x) * 4
      out.push([image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]])
    }
    return out
  }
  assert.deepEqual(row(1), [[11, 21, 31, 255], [201, 101, 51, 255], [8, 9, 10, 255]])
  assert.deepEqual(row(2), [[12, 22, 32, 255], [202, 102, 52, 255], [9, 10, 11, 255]])
})

test('samplePixel refuses a missing coordinate instead of reading a garbage pixel', () => {
  const image = { width: 2, height: 2, data: Buffer.alloc(16) }
  assert.throws(() => samplePixel(image, undefined, 0), /pixel check needs numeric x and y/)
  assert.throws(() => samplePixel(image, 0, 'abc'), /pixel check needs numeric x and y/)
  assert.throws(() => samplePixel(image, Number.NaN, 0), /pixel check needs numeric x and y/)
})

// --- typing: the page must be able to see the character --------------------

test('typeText reports key and code so a page filtering on e.key accepts it', async () => {
  // Regression: only `text` was sent, so the page saw `key: ""` and
  // `code: ""`. A numeric-only field that calls preventDefault() on a
  // non-numeric key then dropped every character — while `type` reported
  // success.
  const { socket, connection } = await connected()
  await typeText(connection, 'S1', 'a1')
  const down = socket.sent.filter((m) => m.method === 'Input.dispatchKeyEvent' && m.params.type === 'keyDown')
  assert.equal(down.length, 2)
  assert.equal(down[0].params.key, 'a')
  assert.equal(down[0].params.code, 'KeyA')
  assert.equal(down[0].params.windowsVirtualKeyCode, 65)
  assert.equal(down[1].params.key, '1')
  assert.equal(down[1].params.code, 'Digit1')
  assert.equal(down[1].params.windowsVirtualKeyCode, 49)
})

test('the key-up does not carry text, so the character is not inserted twice', async () => {
  const { socket, connection } = await connected()
  await typeText(connection, 'S1', 'x')
  const up = socket.sent.find((m) => m.method === 'Input.dispatchKeyEvent' && m.params.type === 'keyUp')
  assert.equal(up.params.text, undefined)
})

test('pressing Space reports the space key, so a checkbox toggles', async () => {
  // Regression: `Space` had no `key`, so the page saw an empty key and the
  // browser's default action (toggling a checkbox) never ran.
  const { socket, connection } = await connected()
  await pressKey(connection, 'S1', 'Space')
  const down = socket.sent.find((m) => m.method === 'Input.dispatchKeyEvent')
  assert.equal(down.params.key, ' ')
  assert.equal(down.params.code, 'Space')
})

test('AltGraph is refused rather than sent as a key with no modifier', async () => {
  // Regression: AltGraph was in the modifier-only set but had no bit, so it
  // went out as `modifiers: 0` with `windowsVirtualKeyCode: 0` — a
  // combination no real browser produces.
  const { pressKey: press } = await import('../lib/cdp.js')
  const { connection } = await connected()
  await assert.rejects(
    press(connection, 'S1', 'AltGraph'),
    (error) => error instanceof CdpError && /AltGr has no single modifier/.test(error.message),
  )
})

// --- network detail: the body must be reachable ---------------------------

test('networkDetail fetches the body with the request id of that record', async () => {
  // Regression: the loop's `requestId` binding was out of scope at the call
  // site, so every body fetch threw a ReferenceError that the catch turned
  // into `body: null` — the body was never obtainable.
  const socket = new FakeSocket()
  socket.responder = (message) => {
    if (message.method === 'Target.attachToTarget') return { sessionId: 'S1' }
    if (message.method === 'Network.getResponseBody') return { body: 'hello-body', base64Encoded: false }
    return {}
  }
  const connection = new CdpConnection('ws://x/devtools/browser/z', { callTimeoutMs: 1000, socketFactory: () => socket })
  const pending = connection.open({ timeoutMs: 500 })
  socket.open()
  await pending
  const pages = new PageSessions(connection, { dialogPolicy: 'ignore' })
  const session = await pages.acquire('T1')
  socket.event(
    'Network.requestWillBeSent',
    { requestId: 'R7', timestamp: 1, request: { method: 'GET', url: 'https://example.test/x' } },
    session.sessionId,
  )
  const detail = await session.networkDetail(1)
  assert.equal(detail.body, 'hello-body')
  assert.equal(detail.bodyBytes, 10)
  assert.equal(detail.bodyNote, undefined)
  const call = socket.sent.find((m) => m.method === 'Network.getResponseBody')
  assert.deepEqual(call.params, { requestId: 'R7' })
})

// --- refs must not alias across snapshots ----------------------------------

test('a ref number is never reissued, so a stale ref cannot point elsewhere', async () => {
  const socket = new FakeSocket()
  socket.responder = (message) => (message.method === 'Target.attachToTarget' ? { sessionId: 'S1' } : {})
  const connection = new CdpConnection('ws://x/devtools/browser/w', { callTimeoutMs: 1000, socketFactory: () => socket })
  const pending = connection.open({ timeoutMs: 500 })
  socket.open()
  await pending
  const pages = new PageSessions(connection, { dialogPolicy: 'ignore' })
  const session = await pages.acquire('T1')

  const first = session.setRefs([{ role: 'button', name: 'First', backendDOMNodeId: 11 }])
  assert.equal(first[0].ref, 'e1')
  const second = session.setRefs([{ role: 'button', name: 'Second', backendDOMNodeId: 22 }])
  // The second snapshot must not hand out "e1" again: the first snapshot's
  // "e1" named a different element, and reusing the number would make a stale
  // ref click the wrong thing without any error.
  assert.notEqual(second[0].ref, 'e1')
  assert.equal(second[0].ref, 'e2')
})

// --- concurrent acquires share one attach ---------------------------------

test('two concurrent acquires for one target attach only once', async () => {
  let attaches = 0
  const socket = new FakeSocket()
  socket.responder = (message) => {
    if (message.method === 'Target.attachToTarget') {
      attaches += 1
      return { sessionId: `S${attaches}` }
    }
    return {}
  }
  const connection = new CdpConnection('ws://x/devtools/browser/v', { callTimeoutMs: 1000, socketFactory: () => socket })
  const pending = connection.open({ timeoutMs: 500 })
  socket.open()
  await pending
  const pages = new PageSessions(connection, { dialogPolicy: 'ignore' })
  const [a, b] = await Promise.all([pages.acquire('T1'), pages.acquire('T1')])
  assert.equal(attaches, 1, 'only one Target.attachToTarget was sent')
  assert.equal(a, b, 'both callers got the same session')
})

test('a detach of a stale session does not remove the live one', async () => {
  // Regression: the detach handler deleted the target's entry by target id,
  // so the detach of an old attachment removed the *live* session's mapping —
  // the tab then looked unattached while its session still worked.
  const socket = new FakeSocket()
  let attaches = 0
  socket.responder = (message) => {
    if (message.method === 'Target.attachToTarget') {
      attaches += 1
      return { sessionId: `S${attaches}` }
    }
    return {}
  }
  const connection = new CdpConnection('ws://x/devtools/browser/u', { callTimeoutMs: 1000, socketFactory: () => socket })
  const pending = connection.open({ timeoutMs: 500 })
  socket.open()
  await pending
  const pages = new PageSessions(connection, { dialogPolicy: 'ignore' })
  const live = await pages.acquire('T1')
  // An older attachment of the same target goes away.
  socket.event('Target.detachedFromTarget', { sessionId: 'S-old' }, undefined)
  assert.equal(pages.peek('T1'), live, 'the live session survived the stale detach')
})

// --- wheel: axes are handled separately ------------------------------------

test('wheel probes both axes so a horizontal container is found', async () => {
  // Regression: the probe only looked at overflowY, so a horizontally
  // scrollable container measured as "not scrollable" — the gesture moved it,
  // the probe saw nothing, and the fallback scrolled a second container.
  const expressions = []
  const { connection } = await connected((message) => {
    if (message.method === 'Runtime.evaluate') {
      expressions.push(message.params.expression)
      return { result: { value: { x: 0, y: 0, hasContainerX: false, hasContainerY: false } } }
    }
    return {}
  })
  await wheelAt(connection, 'S1', 10, 10, 200, 0)
  const probe = expressions.find((e) => e.includes('overflowX'))
  assert.ok(probe, 'the probe looks at the horizontal overflow')
  assert.ok(probe.includes('scrollWidth > node.clientWidth'), 'the horizontal test uses the horizontal size')
})

test('wheel reports which path moved the page', async () => {
  const { connection } = await connected((message) => {
    if (message.method === 'Runtime.evaluate') {
      return { result: { value: { x: 0, y: 0, hasContainerX: false, hasContainerY: false } } }
    }
    return {}
  })
  const result = await wheelAt(connection, 'S1', 10, 10, 0, 100)
  assert.ok(['gesture', 'page', 'page-partial'].includes(result.via))
  assert.equal(result.scrolled.deltaY, 100)
})

// --- wait: the budget must be servable -------------------------------------

test('wait asks the connection for more time than its own budget', async () => {
  // Regression: the wait's default budget equalled the connection's per-call
  // deadline, so the call was killed before the wait could report its own
  // timeout — the caller saw a protocol error instead of `ok: false`.
  const { connection } = await connected((message) =>
    message.method === 'Runtime.evaluate' ? { result: { value: { ok: false, waitedMs: 100 } } } : {},
  )
  const { waitFor, WAIT_BUDGET_MS } = await import('../lib/cdp.js')
  const call = connection.send.bind(connection)
  let usedTimeout = null
  connection.send = (method, params, options) => {
    if (method === 'Runtime.evaluate') usedTimeout = options?.timeoutMs
    return call(method, params, options)
  }
  await waitFor(connection, 'S1', { selector: '#x' })
  assert.ok(usedTimeout > WAIT_BUDGET_MS, 'the call deadline exceeds the wait budget')
})

test('wait cannot be asked for more than the connection can service', async () => {
  const { WAIT_BUDGET_MS } = await import('../lib/cdp.js')
  assert.ok(WAIT_BUDGET_MS < 10_000, 'the default wait budget stays under the per-call deadline')
})

// --- upload paths are confined ---------------------------------------------

// Absolute paths for the platform running the test: a Windows-shaped
// `C:\allowed` is a relative path on POSIX, so it would be refused for the
// wrong reason there.
const root = join(parse(process.cwd()).root, 'dsh-cdp-upload-root')
const outsideFile = join(parse(root).root, 'someone', 'secret.txt')

test('upload refuses a path outside the configured roots', async () => {
  const { __test } = await import('../lib/index.js')
  const { resolveUploadPath } = __test
  const session = { config: { uploadRoots: [root] } }
  assert.throws(() => resolveUploadPath(session, outsideFile), /outside every allowed upload root/)
  assert.throws(() => resolveUploadPath(session, 'relative/path.txt'), /must be absolute/)
  assert.throws(() => resolveUploadPath(session, '\\\\server\\share\\file.txt'), /UNC or device path/)
})

test('upload accepts a path inside a configured root', async () => {
  const { __test } = await import('../lib/index.js')
  const { resolveUploadPath } = __test
  const session = { config: { uploadRoots: [root] } }
  const inner = join(root, 'docs', 'a.txt')
  assert.equal(resolveUploadPath(session, inner), inner)
})

test('upload is disabled when no root is configured', async () => {
  const { __test } = await import('../lib/index.js')
  const { resolveUploadPath } = __test
  const session = { config: { uploadRoots: [] } }
  assert.throws(() => resolveUploadPath(session, outsideFile), /upload is disabled/)
})

// --- dialogs: a pending one blocks the page until it is answered -----------

test('a dialog left open is recorded as pending and can be answered later', async () => {
  const socket = new FakeSocket()
  socket.responder = (message) => (message.method === 'Target.attachToTarget' ? { sessionId: 'S1' } : {})
  const connection = new CdpConnection('ws://x/devtools/browser/t', { callTimeoutMs: 1000, socketFactory: () => socket })
  const pending = connection.open({ timeoutMs: 500 })
  socket.open()
  await pending
  const pages = new PageSessions(connection, { dialogPolicy: 'ignore' })
  const session = await pages.acquire('T1')
  socket.event('Page.javascriptDialogOpening', { type: 'confirm', message: 'sure?' }, session.sessionId)

  const blocking = session.pendingDialog()
  assert.ok(blocking, 'the blocking dialog is reported')
  assert.equal(blocking.message, 'sure?')
  // Nothing was answered on the user's behalf.
  assert.equal(socket.sent.filter((m) => m.method === 'Page.handleJavaScriptDialog').length, 0)

  const answered = await session.answerPendingDialog({ accept: true })
  assert.equal(answered.action, 'accepted')
  assert.equal(session.pendingDialog(), null)
  const call = socket.sent.find((m) => m.method === 'Page.handleJavaScriptDialog')
  assert.equal(call.params.accept, true)
})

test('answering a dialog that is not there is refused', async () => {
  const socket = new FakeSocket()
  socket.responder = (message) => (message.method === 'Target.attachToTarget' ? { sessionId: 'S1' } : {})
  const connection = new CdpConnection('ws://x/devtools/browser/s', { callTimeoutMs: 1000, socketFactory: () => socket })
  const pending = connection.open({ timeoutMs: 500 })
  socket.open()
  await pending
  const pages = new PageSessions(connection, { dialogPolicy: 'ignore' })
  const session = await pages.acquire('T1')
  await assert.rejects(session.answerPendingDialog({ accept: true }), /no dialog is waiting/)
})

// --- a closed tab fails its in-flight calls straight away ------------------

test('closing a tab fails the calls that were in flight against it', async () => {
  const socket = new FakeSocket()
  socket.responder = (message) => (message.method === 'Target.attachToTarget' ? { sessionId: 'S1' } : {})
  const connection = new CdpConnection('ws://x/devtools/browser/r', { callTimeoutMs: 60_000, socketFactory: () => socket })
  const pending = connection.open({ timeoutMs: 500 })
  socket.open()
  await pending
  const pages = new PageSessions(connection, { dialogPolicy: 'ignore' })
  const session = await pages.acquire('T1')

  // A call that the browser will never answer.
  const inFlight = session.send('Runtime.evaluate', { expression: '1' })
  // The user closes the tab.
  socket.event('Target.detachedFromTarget', { sessionId: 'S1' }, undefined)
  await assert.rejects(
    inFlight,
    (error) => error instanceof CdpError && /tab was closed/.test(error.message),
  )
})

test('eval keeps an array\'s contents instead of describing it as an opaque object', async () => {
  // Regression: the description branch keyed on `subtype`, and an array's
  // RemoteObject carries `subtype: 'array'` *alongside* a valid `value`. Every
  // array therefore came back as "[Array]" with its contents dropped.
  const { evaluateDescribed } = await import('../lib/cdp.js')
  const { connection } = await connected((message) =>
    message.method === 'Runtime.evaluate'
      ? { result: { value: [1, 2, 3], type: 'object', subtype: 'array' } }
      : {},
  )
  const described = await evaluateDescribed(connection, 'S1', '[1,2,3]')
  assert.equal(described.kind, 'value')
  assert.deepEqual(described.value, [1, 2, 3])
})

test('eval describes a DOM node rather than returning an empty object', async () => {
  const { evaluateDescribed } = await import('../lib/cdp.js')
  const { connection } = await connected((message) =>
    message.method === 'Runtime.evaluate'
      ? { result: { type: 'object', subtype: 'node', className: 'HTMLBodyElement', description: 'body' } }
      : {},
  )
  // No `value` at all: that is what "cannot be sent as JSON" looks like.
  const described = await evaluateDescribed(connection, 'S1', 'document.body')
  assert.equal(described.kind, 'object')
  assert.equal(described.description, 'body')
})

test('eval reports NaN as unserializable rather than as null', async () => {
  const { evaluateDescribed } = await import('../lib/cdp.js')
  const { connection } = await connected((message) =>
    message.method === 'Runtime.evaluate'
      ? { result: { type: 'number', unserializableValue: 'NaN', description: 'NaN' } }
      : {},
  )
  const described = await evaluateDescribed(connection, 'S1', 'NaN')
  assert.equal(described.kind, 'unserializable')
  assert.equal(described.value, 'NaN')
})

// --- a point outside the viewport is not clickable -------------------------

test('a point outside the viewport is refused rather than clicked', async () => {
  // Regression: an off-screen fixed element produced negative coordinates that
  // were dispatched anyway; the page never saw the click but the command
  // reported success.
  const { __test } = await import('../lib/cdp.js')
  const { POINT_FN } = __test
  assert.match(POINT_FN, /inViewport/)
  const { dispatchPoint } = await import('../lib/cdp.js')
  await assert.rejects(
    dispatchPoint({ send: async () => {} }, 'S1', { dom: false, x: -130, y: 30, covered: false, inViewport: false }, {}, '#off'),
    (error) => error instanceof CdpError && /outside the viewport/.test(error.message),
  )
})
