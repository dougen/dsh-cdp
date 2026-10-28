// strictTabs guard, owned-tab registry, and the small pure helpers exported
// through `__test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'
import { BrowserSession, __test } from '../lib/index.js'
import { CdpError, FailureKind } from '../lib/cdp.js'

const { approvalWatchStep, checkWriteTab, clipText, isLocalHost, resolveShotDir } = __test

function session(config = {}) {
  return new BrowserSession({}, config)
}

test('owned-tab registry tracks open and close', () => {
  const s = session()
  assert.equal(s.ownsTab('A'), false)
  s.ownTab('A')
  assert.equal(s.ownsTab('A'), true)
  s.forgetTab('A')
  assert.equal(s.ownsTab('A'), false)
})

test('checkWriteTab demands an explicit owned tabId when strictTabs is on', () => {
  const s = session({ strictTabs: true })
  s.ownTab('A')

  // No tabId at all: an error, not the old first-page fallback.
  assert.throws(() => checkWriteTab(s, 'goto', {}), /requires the tabId/)
  assert.throws(() => checkWriteTab(s, 'click', { tabId: '' }), /requires the tabId/)

  // A tab the session did not open (e.g. the user's active tab).
  assert.throws(
    () => checkWriteTab(s, 'goto', { tabId: 'USERS_TAB' }),
    /refused: tab USERS_TAB was not opened by this session/,
  )

  // The one tab this session opened passes.
  checkWriteTab(s, 'goto', { tabId: 'A' })
})

test('checkWriteTab obeys the strictTabs escape hatch', () => {
  const s = session({ strictTabs: false })
  // Legacy behaviour restored: no tabId needed, any tab allowed.
  checkWriteTab(s, 'goto', {})
  checkWriteTab(s, 'type', { tabId: 'USERS_TAB' })
})

test('checkWriteTab reports CdpError so the route maps it onto the error envelope', () => {
  const s = session({ strictTabs: true })
  try {
    checkWriteTab(s, 'close', {})
    assert.fail('expected a throw')
  } catch (error) {
    assert.ok(error instanceof CdpError)
  }
})

test('isLocalHost accepts only loopback Host headers', () => {
  const req = (host) => ({ headers: { host } })
  assert.equal(isLocalHost(req('127.0.0.1:8080')), true)
  assert.equal(isLocalHost(req('localhost:3000')), true)
  assert.equal(isLocalHost(req('[::1]:9000')), true)
  assert.equal(isLocalHost(req('evil.example')), false)
  assert.equal(isLocalHost(req('127.0.0.1.evil.example')), false)
  assert.equal(isLocalHost({ headers: {} }), false)
})

test('clipText truncates by bytes without splitting a surrogate pair', () => {
  assert.equal(clipText('short', 100), 'short')
  const cut = clipText('abcdefghij', 4)
  assert.equal(cut.slice(0, 4), 'abcd')
  assert.match(cut, /…\[truncated\]$/)
  // '汉' is 3 bytes; a 4-byte budget must not cut inside it.
  const cjk = clipText('一二三四五', 4)
  assert.equal(cjk.startsWith('一'), true)
  assert.equal(cjk.includes('\uFFFD'), false)
})

test('resolveShotDir keeps shots under the configured directory', () => {
  // Built with the platform's own separators so the expectations hold on
  // Windows and POSIX alike.
  const base = resolve('dsh-cdp-shot-root', 'shots')
  const s = session({ shotDir: base })
  // Omitted / empty / "." all mean the base itself.
  assert.equal(resolveShotDir(s, undefined), base)
  assert.equal(resolveShotDir(s, ''), base)
  assert.equal(resolveShotDir(s, '.'), base)
  // A relative subdirectory is fine, in either separator style.
  assert.equal(resolveShotDir(s, 'sub'), join(base, 'sub'))
  assert.equal(resolveShotDir(s, 'a/b'), join(base, 'a', 'b'))
  if (sep === '\\') assert.equal(resolveShotDir(s, 'a\\b'), join(base, 'a', 'b'))
})

test('resolveShotDir refuses anything that escapes the screenshot dir', () => {
  const base = resolve('dsh-cdp-shot-root', 'shots')
  const s = session({ shotDir: base })
  // An absolute path outside the base is refused on every platform.
  const outside = join(parse(base).root, 'definitely-outside')
  assert.throws(() => resolveShotDir(s, '..'), /escapes/)
  assert.throws(() => resolveShotDir(s, join('sub', '..', '..', 'x')), /escapes/)
  assert.throws(() => resolveShotDir(s, outside), /escapes/)
  assert.throws(() => resolveShotDir(s, 42), /relative to the screenshot dir/)
})

const GIVE_UP = 90_000

test('approvalWatchStep promotes a socket that finally opened', () => {
  assert.equal(approvalWatchStep(null, 0, GIVE_UP), 'promote')
  assert.equal(approvalWatchStep(null, GIVE_UP * 10, GIVE_UP), 'promote')
})

test('approvalWatchStep keeps waiting on silence inside the budget', () => {
  assert.equal(approvalWatchStep(FailureKind.AwaitingApproval, 0, GIVE_UP), 'wait')
  assert.equal(approvalWatchStep(FailureKind.AwaitingApproval, GIVE_UP - 1, GIVE_UP), 'wait')
})

test('approvalWatchStep recovers once the budget is exhausted', () => {
  // Even though the socket is still silent, a real prompt does not wait this
  // long — staying parked forever is the bug this replaces.
  assert.equal(approvalWatchStep(FailureKind.AwaitingApproval, GIVE_UP, GIVE_UP), 'recover')
  assert.equal(approvalWatchStep(FailureKind.AwaitingApproval, GIVE_UP * 2, GIVE_UP), 'recover')
})

test('approvalWatchStep recovers immediately when the socket died', () => {
  // A dead socket can never open: waiting on it is the stuck-state path.
  assert.equal(approvalWatchStep(FailureKind.Unreachable, 0, GIVE_UP), 'recover')
  assert.equal(approvalWatchStep(FailureKind.Protocol, 0, GIVE_UP), 'recover')
  assert.equal(approvalWatchStep(FailureKind.Aborted, 0, GIVE_UP), 'recover')
})

// --- a dropped socket stays down until a command asks for it ---------------
//
// Chromium asks for remote-debugging approval on every new connection. A browser
// restart kills the socket; re-establishing it on the plugin's own initiative
// therefore raises the prompt the moment the user opens their browser again, for
// a session that never asked to drive it. Attaching is demand-driven instead.

/** Poll until `predicate` holds. */
async function until(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** The socket half of the global `WebSocket`, recording every instance made. */
class FakeWebSocket {
  constructor(sockets) {
    this.readyState = 0
    this.listeners = new Map()
    this.sent = []
    this.sockets = sockets
    sockets.push(this)
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  #emit(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }

  send(data) {
    const message = JSON.parse(data)
    this.sent.push(message)
    queueMicrotask(() => {
      this.#emit('message', { data: JSON.stringify({ id: message.id, result: { targetInfos: [] } }) })
    })
  }

  open() {
    this.readyState = 1
    this.#emit('open')
  }

  close() {
    this.readyState = 3
    this.#emit('close')
  }
}

test('a dropped connection is not re-established until a command asks for it', async () => {
  const sockets = []
  class StubWebSocket extends FakeWebSocket {
    constructor() {
      super(sockets)
    }
  }

  // The browser's side of discovery: a listening port plus the port file that
  // points at it. The HTTP route answers 404, as approval mode does.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cdp-drop-'))
  const server = createServer((req, res) => {
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await writeFile(join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/fake\n`)

  const previousWebSocket = globalThis.WebSocket
  globalThis.WebSocket = StubWebSocket
  // `ports: []` keeps the test off whatever real debug port exists on the host.
  const s = new BrowserSession({}, { dataDir: dir, ports: [], autoConnect: false })

  try {
    const connecting = s.connect()
    await until(() => sockets.length === 1)
    sockets[0].open()
    await connecting
    assert.equal(s.state, 'connected')

    // The browser quits: its socket closes.
    sockets[0].close()
    assert.equal(s.state, 'disconnected')
    assert.equal(s.snapshot().endpoint, null)

    // Longer than the first backoff step. Re-attaching here is exactly the
    // regression: it would ask the user to approve a browser they just opened.
    await new Promise((resolve) => setTimeout(resolve, 3500))
    assert.equal(sockets.length, 1, 'nothing attached in the background')
    assert.equal(s.state, 'disconnected')

    // A command is the demand, so this attempt is allowed to attach again.
    const attaching = s.connect()
    await until(() => sockets.length === 2)
    sockets[1].open()
    await attaching
    assert.equal(s.state, 'connected')
  } finally {
    await s.dispose().catch(() => {})
    globalThis.WebSocket = previousWebSocket
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
