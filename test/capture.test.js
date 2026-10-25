// PageSession capture buffers driven by injected protocol events — the console,
// network, dialog, and ref bookkeeping that used to be untestable because the
// session was detached after every command.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CdpConnection, CdpError, NETWORK_LIMIT, PageSessions } from '../lib/cdp.js'
import { __test as cdpTest } from '../lib/cdp.js'

const { POINT_FN } = cdpTest

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

/** A connection whose attach and domain-enable calls answer immediately. */
async function attached() {
  const socket = new FakeSocket()
  socket.responder = (message) => {
    if (message.method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
    if (message.method === 'Runtime.callFunctionOn') return { result: { value: null } }
    return {}
  }
  const connection = new CdpConnection('ws://x/devtools/browser/y', { callTimeoutMs: 1000, socketFactory: () => socket })
  const pending = connection.open({ timeoutMs: 500 })
  socket.open()
  await pending
  const pages = new PageSessions(connection, { dialogPolicy: 'dismiss', dialogPolicyFor: () => 'dismiss' })
  const session = await pages.acquire('TARGET-1')
  return { socket, connection, pages, session }
}

test('console capture keeps level and text, and filters by level', async () => {
  const { socket, session } = await attached()

  socket.event(
    'Runtime.consoleAPICalled',
    { type: 'log', args: [{ value: 'hello' }, { value: 42 }] },
    session.sessionId,
  )
  socket.event('Runtime.consoleAPICalled', { type: 'warning', args: [{ value: 'careful' }] }, session.sessionId)
  socket.event('Runtime.exceptionThrown', { exceptionDetails: { text: 'boom' } }, session.sessionId)

  const all = session.consoleEntries()
  assert.equal(all.entries.length, 3)
  assert.equal(all.entries[0].text, 'hello 42')
  assert.equal(all.entries[1].level, 'warning')
  assert.equal(all.entries[2].level, 'error')

  const warnings = session.consoleEntries({ level: 'warning' })
  assert.equal(warnings.entries.length, 1)
  assert.equal(warnings.entries[0].text, 'careful')
})

test('console events from another page session are ignored', async () => {
  const { socket, session } = await attached()
  socket.event('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'other tab' }] }, 'SESSION-OTHER')
  assert.equal(session.consoleEntries().entries.length, 0)
  socket.event('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'mine' }] }, session.sessionId)
  assert.equal(session.consoleEntries().entries.length, 1)
})

test('network capture merges the response pass into the request record', async () => {
  const { socket, session } = await attached()
  socket.event(
    'Network.requestWillBeSent',
    { requestId: 'R1', type: 'Fetch', timestamp: 10, request: { method: 'GET', url: 'https://example.test/a' } },
    session.sessionId,
  )
  socket.event(
    'Network.responseReceived',
    { requestId: 'R1', timestamp: 10.25, response: { status: 200, mimeType: 'application/json', headers: { 'x-a': 'b' } } },
    session.sessionId,
  )
  // The duration belongs to the end of the loading, so it is only known once
  // the body has finished arriving — a streamed body used to be reported at
  // its first byte.
  assert.equal(session.networkList().requests[0].ttfbMs, 250)
  assert.equal(session.networkList().requests[0].durationMs, undefined, 'not measurable before the load ends')
  socket.event('Network.loadingFinished', { requestId: 'R1', timestamp: 10.5 }, session.sessionId)
  const list = session.networkList()
  assert.equal(list.total, 1)
  const row = list.requests[0]
  assert.equal(row.url, 'https://example.test/a')
  assert.equal(row.status, 200)
  assert.equal(row.durationMs, 500)
  assert.equal(row.startedAt, undefined, 'the monotonic clock reading is not a reportable field')
})

test('a request index is stable across the ring buffer dropping old entries', async () => {
  const { socket, session } = await attached()
  const total = NETWORK_LIMIT + 5
  for (let i = 1; i <= total; i += 1) {
    socket.event(
      'Network.requestWillBeSent',
      { requestId: `R${i}`, timestamp: i, request: { method: 'GET', url: `https://example.test/${i}` } },
      session.sessionId,
    )
  }
  // A budget big enough not to trim: this test is about numbering, not size.
  const list = session.networkList({ limit: NETWORK_LIMIT, maxBytes: 10_000_000 })
  assert.equal(list.total, NETWORK_LIMIT, 'the buffer is capped')
  assert.equal(list.dropped, 5)
  // The oldest surviving request keeps its own number, not a shifted position.
  assert.equal(list.requests[0].index, 6)
  assert.equal(list.requests.at(-1).index, total)
})

test('the request list honours its byte budget by dropping the oldest rows', async () => {
  const { socket, session } = await attached()
  for (let i = 1; i <= 200; i += 1) {
    socket.event(
      'Network.requestWillBeSent',
      { requestId: `R${i}`, timestamp: i, request: { method: 'GET', url: `https://example.test/${i}` } },
      session.sessionId,
    )
  }
  const list = session.networkList({ limit: 200, maxBytes: 4_000 })
  assert.equal(list.total, 200, 'every request was captured')
  assert.ok(list.returned < 200, 'the list was trimmed to fit')
  assert.equal(list.trimmed, true)
  assert.ok(
    Buffer.byteLength(JSON.stringify(list.requests), 'utf8') <= 4_000,
    'the trimmed list fits the budget',
  )
  // The newest request survives the trim: the newest is what the caller wants.
  assert.equal(list.requests.at(-1).index, 200)
})

test('the default limit trims the tail without renumbering it', async () => {
  const { socket, session } = await attached()
  for (let i = 1; i <= 130; i += 1) {
    socket.event(
      'Network.requestWillBeSent',
      { requestId: `R${i}`, timestamp: i, request: { method: 'GET', url: `https://example.test/${i}` } },
      session.sessionId,
    )
  }
  const list = session.networkList({})
  assert.equal(list.total, 130)
  assert.equal(list.requests.length, 100, 'default limit keeps the newest 100')
  assert.equal(list.requests[0].index, 31, 'the number is the request\'s own, not the row position')
})

test('a filter narrows the list without renumbering what it shows', async () => {
  const { socket, session } = await attached()
  for (const [id, url] of [
    ['R1', 'https://example.test/page'],
    ['R2', 'https://cdn.test/app.js'],
    ['R3', 'https://cdn.test/style.css'],
  ]) {
    socket.event(
      'Network.requestWillBeSent',
      { requestId: id, timestamp: 1, request: { method: 'GET', url } },
      session.sessionId,
    )
  }
  const filtered = session.networkList({ filter: 'cdn\\.test' })
  assert.equal(filtered.total, 2)
  assert.deepEqual(filtered.requests.map((r) => r.index), [2, 3])
})

test('an invalid filter is reported, not silently treated as no filter', async () => {
  const { session } = await attached()
  assert.throws(() => session.networkList({ filter: '(' }), /not a valid regular expression/)
})

test('dialogPolicy answers on an owned tab and only records elsewhere', async () => {
  // A fresh connection with a policy that depends on the tab. Attach returns a
  // distinct sessionId per target so the two tabs stay distinguishable.
  const socketB = new FakeSocket()
  let next = 0
  socketB.responder = (message) =>
    message.method === 'Target.attachToTarget' ? { sessionId: `S-${message.params.targetId}-${(next += 1)}` } : {}
  const connectionB = new CdpConnection('ws://x/devtools/browser/z', { callTimeoutMs: 1000, socketFactory: () => socketB })
  const pendingB = connectionB.open({ timeoutMs: 500 })
  socketB.open()
  await pendingB
  const pagesB = new PageSessions(connectionB, {
    dialogPolicy: 'dismiss',
    dialogPolicyFor: (targetId) => (targetId === 'MINE' ? 'dismiss' : 'ignore'),
  })
  const mine = await pagesB.acquire('MINE')
  socketB.event('Page.javascriptDialogOpening', { type: 'confirm', message: 'sure?' }, mine.sessionId)
  assert.equal(mine.dialogEntries().length, 1)
  assert.equal(mine.dialogEntries()[0].action, 'dismissed')
  // The answering call went out for the owned tab.
  assert.ok(socketB.sent.some((m) => m.method === 'Page.handleJavaScriptDialog' && m.params.accept === false))

  const theirs = await pagesB.acquire('THEIRS')
  socketB.event('Page.javascriptDialogOpening', { type: 'alert', message: 'hands off' }, theirs.sessionId)
  assert.equal(theirs.dialogEntries().length, 1)
  assert.equal(theirs.dialogEntries()[0].action, 'ignored')
  // Only the one answer for the owned tab exists; nothing was sent for theirs.
  const answers = socketB.sent.filter((m) => m.method === 'Page.handleJavaScriptDialog')
  assert.equal(answers.length, 1)
})

test('an unknown ref is refused with an actionable message', async () => {
  const { session } = await attached()
  await assert.rejects(
    session.withRefObject('e99', () => {}),
    /unknown ref "e99" — take a fresh snapshot/,
  )
})

test('a ref handle is released after use', async () => {
  const socketC = new FakeSocket()
  socketC.responder = (message) => {
    if (message.method === 'Target.attachToTarget') return { sessionId: 'SESSION-R' }
    if (message.method === 'DOM.resolveNode') return { object: { objectId: 'OBJ-1' } }
    return {}
  }
  const connectionC = new CdpConnection('ws://x/devtools/browser/r', { callTimeoutMs: 1000, socketFactory: () => socketC })
  const pendingC = connectionC.open({ timeoutMs: 500 })
  socketC.open()
  await pendingC
  const pagesC = new PageSessions(connectionC)
  const session = await pagesC.acquire('TARGET-R')
  session.setRefs([{ role: 'button', name: 'Save', backendDOMNodeId: 7 }])
  const seen = await session.withRefObject('e1', (objectId) => objectId)
  assert.equal(seen, 'OBJ-1')
  assert.ok(
    socketC.sent.some((m) => m.method === 'Runtime.releaseObject' && m.params.objectId === 'OBJ-1'),
    'the handle does not outlive the call',
  )
})

test('setRefs assigns sequential handles and skips nodes with no DOM id', async () => {
  const { session } = await attached()
  const nodes = session.setRefs([
    { role: 'button', name: 'Save', backendDOMNodeId: 11 },
    { role: 'none', name: '', backendDOMNodeId: null },
    { role: 'link', name: 'Home', backendDOMNodeId: 22 },
  ])
  assert.equal(nodes[0].ref, 'e1')
  assert.equal(nodes[1].ref, null)
  assert.equal(nodes[2].ref, 'e2')
})

test('detaching a target drops its session so the next command reattaches', async () => {
  const { socket, pages, session } = await attached()
  assert.ok(pages.peek('TARGET-1') !== undefined)
  socket.event('Target.detachedFromTarget', { sessionId: session.sessionId }, undefined)
  assert.equal(pages.peek('TARGET-1'), undefined)
  assert.equal(session.closed, true)
})

test('closeAll detaches every held session', async () => {
  const { pages, session } = await attached()
  await pages.closeAll()
  assert.equal(session.closed, true)
  assert.equal(pages.size, 0)
})

test('a closed session refuses further calls rather than hanging', async () => {
  const { pages, session } = await attached()
  await pages.closeAll()
  await assert.rejects(async () => session.send('Runtime.evaluate', { expression: '1' }), /page session is closed/)
})

test('pointFor needs a selector or a ref', async () => {
  const { session } = await attached()
  await assert.rejects(session.pointFor({}), (error) => error instanceof CdpError && /needs a selector or a ref/.test(error.message))
})

test('a selector that matches nothing reports "no element", not a TypeError', async () => {
  // Regression: the point function is invoked with `.call(querySelector(...))`,
  // and in sloppy mode `.call(null)` hands it the global object. Without the
  // shape guard, the miss surfaced as "el.getBoundingClientRect is not a
  // function" — a protocol error that reads like a plugin bug to the caller.
  // The response here mimics the page's own evaluation: `null` for a miss.
  const socket = new FakeSocket()
  socket.responder = (message) => {
    if (message.method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
    if (message.method === 'Runtime.evaluate') return { result: { value: null } }
    return {}
  }
  const connection = new CdpConnection('ws://x/devtools/browser/q', { callTimeoutMs: 1000, socketFactory: () => socket })
  const pending = connection.open({ timeoutMs: 500 })
  socket.open()
  await pending
  const pages = new PageSessions(connection, { dialogPolicy: 'ignore' })
  const session = await pages.acquire('TARGET-MISS')
  await assert.rejects(
    session.pointFor({ selector: '#nope' }),
    (error) => error instanceof CdpError && /no element matches selector #nope/.test(error.message),
  )
})

test('the embedded point function is strict so a null receiver stays null', () => {
  // The page-side contract the plugin depends on: strict mode is what keeps
  // `.call(null)` from handing the function the global object.
  assert.match(POINT_FN, /'use strict'/)
  assert.match(POINT_FN, /typeof el\.getBoundingClientRect !== 'function'/)
})
