// The pieces added in 0.4.0 that are pure logic: key-spec parsing, the
// modifier bitmask, and the per-session capture buffers. No browser, no socket.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONSOLE_LIMIT,
  NETWORK_LIMIT,
  CdpConnection,
  CdpError,
  modifierMask,
  parseKeySpec,
} from '../lib/cdp.js'

test('parseKeySpec splits a modifier chord', () => {
  assert.deepEqual(parseKeySpec('Enter'), { name: 'Enter', modifiers: 0, held: [] })
  assert.deepEqual(parseKeySpec('a'), { name: 'a', modifiers: 0, held: [] })
  const ctrlA = parseKeySpec('Ctrl+A')
  assert.equal(ctrlA.name, 'A')
  assert.equal(ctrlA.modifiers, 2)
  const ctrlShiftA = parseKeySpec('Ctrl+Shift+A')
  assert.equal(ctrlShiftA.name, 'A')
  assert.equal(ctrlShiftA.modifiers, 2 | 8)
})

test('parseKeySpec handles the plus key itself', () => {
  // "Ctrl++" and a bare "+" both mean "the plus key", with the trailing empty
  // segment that split('+') produces.
  assert.equal(parseKeySpec('+').name, '+')
  const ctrlPlus = parseKeySpec('Ctrl++')
  assert.equal(ctrlPlus.name, '+')
  assert.equal(ctrlPlus.modifiers, 2)
})

test('parseKeySpec rejects an unknown modifier instead of silently dropping it', () => {
  assert.throws(() => parseKeySpec('Hyper+A'), /unknown modifier "Hyper"/)
  assert.throws(() => parseKeySpec(''), /key requires a key name/)
})

test('modifierMask accumulates names and accepts a single string', () => {
  assert.equal(modifierMask(undefined), 0)
  assert.equal(modifierMask('ctrl'), 2)
  assert.equal(modifierMask(['ctrl', 'shift']), 10)
  assert.equal(modifierMask(['meta', 'alt']), 5)
  assert.throws(() => modifierMask(['hyper']), /unknown modifier/)
})

test('capture buffers are capped', () => {
  // The cap is a memory bound on a long-lived session: assert the constants
  // are finite and nonzero so a regression cannot make them unbounded.
  assert.ok(CONSOLE_LIMIT > 0 && Number.isFinite(CONSOLE_LIMIT))
  assert.ok(NETWORK_LIMIT > 0 && Number.isFinite(NETWORK_LIMIT))
})

// A minimal fake socket, enough to build a connection whose events can be
// injected without any real transport.
class FakeSocket {
  constructor() {
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
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
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3
    this.emit('close')
  }

  reply(id, result) {
    this.emit('message', { data: JSON.stringify({ id, result }) })
  }

  event(method, params, sessionId) {
    this.emit('message', { data: JSON.stringify({ method, params, sessionId }) })
  }
}

async function connected() {
  const socket = new FakeSocket()
  const connection = new CdpConnection('ws://127.0.0.1:9222/devtools/browser/x', {
    callTimeoutMs: 1000,
    socketFactory: () => socket,
  })
  const pending = connection.open({ timeoutMs: 500 })
  socket.open()
  await pending
  return { socket, connection }
}

test('once() filters by sessionId so one tab cannot satisfy another tab\'s wait', async () => {
  const { socket, connection } = await connected()
  let resolved = null
  const wait = connection.once('Page.loadEventFired', 500, 'S-tab-A').then(() => {
    resolved = 'A'
  })

  // A load in a different tab arrives first. With the filter, it must be
  // ignored — otherwise a navigate waits on whichever tab loads first.
  socket.event('Page.loadEventFired', {}, 'S-tab-B')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(resolved, null, 'the other tab\'s event did not satisfy the wait')

  socket.event('Page.loadEventFired', {}, 'S-tab-A')
  await wait
  assert.equal(resolved, 'A')
})

test('an unscoped once() still hears events from any session', async () => {
  const { socket, connection } = await connected()
  const wait = connection.once('Page.loadEventFired', 500)
  socket.event('Page.loadEventFired', {}, 'whatever')
  await wait
})

test('a CdpError carries its failure kind through the event filter', async () => {
  const { connection } = await connected()
  await assert.rejects(
    connection.once('Page.loadEventFired', 20, 'S1'),
    (error) => error instanceof CdpError && /timed out waiting for Page\.loadEventFired/.test(error.message),
  )
})
