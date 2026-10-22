// CdpConnection against a fake socket — the handshake/timeout/pending-request
// state machine, including the "parked socket adopted after approval" path,
// without a browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { CdpConnection, CdpError, FailureKind, runChecks, screenshot } from '../lib/cdp.js'

class FakeSocket {
  constructor() {
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
    /**
     * Optional auto-responder: `(message) => result | { error }`. Replies are
     * emitted on a microtask — the real protocol never answers synchronously,
     * and a synchronous reply would race the pending-slot registration.
     */
    this.responder = null
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  #emit(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }

  open() {
    this.readyState = 1
    this.#emit('open')
  }

  fail() {
    this.readyState = 3
    this.#emit('error', {})
    this.#emit('close', {})
  }

  close() {
    this.readyState = 3
    this.#emit('close')
  }

  send(data) {
    const message = JSON.parse(data)
    this.sent.push(message)
    if (this.responder !== null) {
      const outcome = this.responder(message)
      queueMicrotask(() => {
        if (outcome && typeof outcome === 'object' && 'error' in outcome) this.replyError(message.id, outcome.error)
        else this.reply(message.id, outcome)
      })
    }
    return message
  }

  reply(id, result) {
    this.#emit('message', { data: JSON.stringify({ id, result }) })
  }

  replyError(id, error) {
    this.#emit('message', { data: JSON.stringify({ id, error }) })
  }

  event(method, params) {
    this.#emit('message', { data: JSON.stringify({ method, params }) })
  }
}

function connect({ callTimeoutMs = 200 } = {}) {
  const socket = new FakeSocket()
  const connection = new CdpConnection('ws://127.0.0.1:9222/devtools/browser/x', {
    callTimeoutMs,
    socketFactory: () => socket,
  })
  return { socket, connection }
}

// A 1×1 solid-colour PNG the runChecks test can decode without a browser.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let crcTable = null
function crc32(buf) {
  if (crcTable === null) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function solidPng([r, g, b]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const scanline = Buffer.from([0, r, g, b, 255]) // filter 0, one pixel
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanline)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * A connected pair. The `open` event only reaches the connection's listeners
 * once they exist — `connection.open()` installs them — so the socket must be
 * opened *after* the call, exactly like a real handshake.
 */
async function connected({ callTimeoutMs = 200 } = {}) {
  const { socket, connection } = connect({ callTimeoutMs })
  const handshake = connection.open({ timeoutMs: 500 })
  socket.open()
  await handshake
  return { socket, connection }
}

test('open resolves once the socket opens', async () => {
  const { socket, connection } = connect()
  const pending = connection.open({ timeoutMs: 500 })
  socket.open()
  await pending
  assert.equal(connection.connected, true)
})

test('open timeout is classified as awaiting approval, and the parked socket is adopted later', async () => {
  const { socket, connection } = connect()
  await assert.rejects(
    connection.open({ timeoutMs: 30 }),
    (error) => error instanceof CdpError && error.kind === FailureKind.AwaitingApproval,
  )
  // The browser approved after the deadline: no second socket, same one adopted.
  socket.open()
  await connection.waitForOpen({ timeoutMs: 500 })
  assert.equal(connection.connected, true)
})

test('open rejects as unreachable when the socket errors', async () => {
  const { socket, connection } = connect()
  const pending = connection.open({ timeoutMs: 500 })
  socket.fail()
  await assert.rejects(
    pending,
    (error) => error instanceof CdpError && error.kind === FailureKind.Unreachable,
  )
})

test('send resolves with the matching reply, keyed by session', async () => {
  const { socket, connection } = await connected()

  const pending = connection.send('Runtime.evaluate', { expression: '1' }, { sessionId: 'S1' })
  const message = socket.sent.at(-1)
  assert.equal(message.method, 'Runtime.evaluate')
  assert.equal(message.sessionId, 'S1')
  socket.reply(message.id, { result: { value: 42 } })
  assert.deepEqual(await pending, { result: { value: 42 } })
})

test('send surfaces protocol errors', async () => {
  const { socket, connection } = await connected()

  const pending = connection.send('Page.navigate', { url: 'x' })
  socket.replyError(socket.sent.at(-1).id, { message: 'bad url', code: -32000 })
  await assert.rejects(
    pending,
    (error) => error instanceof CdpError && error.kind === FailureKind.Protocol && /bad url/.test(error.message),
  )
})

test('send rejects on timeout and forgets the pending slot', async () => {
  const { socket, connection } = await connected({ callTimeoutMs: 30 })

  await assert.rejects(
    connection.send('Target.getTargets'),
    (error) => error instanceof CdpError && error.kind === FailureKind.Protocol && /timed out/.test(error.message),
  )
  // The late reply for the abandoned id must not resolve anything.
  socket.reply(socket.sent.at(-1).id, { targetInfos: [] })
})

test('once resolves on the event and stops listening afterwards', async () => {
  const { socket, connection } = await connected()

  let fired = 0
  connection.on('Page.loadEventFired', () => {
    fired += 1
  })
  const pending = connection.once('Page.loadEventFired', 500)
  socket.event('Page.loadEventFired', {})
  await pending
  socket.event('Page.loadEventFired', {}) // the once-subscription is gone
  assert.equal(fired, 2) // but the persistent on-listener still hears it
})

test('a closed connection fails pending sends', async () => {
  const { socket, connection } = await connected({ callTimeoutMs: 5000 })

  const pending = connection.send('Target.getTargets')
  socket.close()
  await assert.rejects(
    pending,
    (error) => error instanceof CdpError && error.kind === FailureKind.Unreachable,
  )
  await assert.rejects(connection.send('Target.getTargets'), /not connected/)
})

test('socket loss reaches onClose, never the CDP event bus', async () => {
  const { socket, connection } = await connected({ callTimeoutMs: 5000 })

  let busHits = 0
  let closeHits = 0
  // The protocol has no "close" event: this listener must stay silent forever.
  connection.on('close', () => {
    busHits += 1
  })
  connection.onClose(() => {
    closeHits += 1
  })
  const off = connection.onClose(() => {
    closeHits += 1
  })
  off() // subscribed then unsubscribed: only the first must fire

  socket.close()
  assert.equal(closeHits, 1, 'the unsubscribed listener was not notified')
  assert.equal(busHits, 0, 'the CDP event bus does not carry socket loss')
  assert.equal(connection.connected, false)

  // A socket dies once: a duplicate close event must not re-notify.
  socket.fail()
  assert.equal(closeHits, 1)
})

test('viewport screenshot sends no clip', async () => {
  const { socket, connection } = await connected()
  socket.responder = (message) =>
    message.method === 'Page.captureScreenshot' ? { data: Buffer.from('png-bytes').toString('base64') } : undefined

  const { png, truncated } = await screenshot(connection, 'S1')
  const shot = socket.sent.find((m) => m.method === 'Page.captureScreenshot')
  assert.equal(shot.params.clip, undefined)
  assert.equal(shot.params.captureBeyondViewport, undefined)
  assert.equal(png.toString(), 'png-bytes')
  assert.equal(truncated, false)
})

test('fullPage screenshot clips beyond the viewport, caps height, and reports truncation', async () => {
  const { socket, connection } = await connected()
  socket.responder = (message) => {
    if (message.method === 'Runtime.evaluate') return { result: { value: { w: 400, h: 20000 } } }
    if (message.method === 'Page.captureScreenshot') return { data: Buffer.from('png-bytes').toString('base64') }
    return undefined
  }

  const { truncated } = await screenshot(connection, 'S1', { fullPage: true })
  const shot = socket.sent.find((m) => m.method === 'Page.captureScreenshot')
  assert.equal(shot.params.captureBeyondViewport, true)
  assert.deepEqual(shot.params.clip, { x: 0, y: 0, width: 400, height: 8000, scale: 1 })
  assert.equal(truncated, true)
})

test('fullPage screenshot under the cap reports no truncation', async () => {
  const { socket, connection } = await connected()
  socket.responder = (message) => {
    if (message.method === 'Runtime.evaluate') return { result: { value: { w: 400, h: 3000 } } }
    if (message.method === 'Page.captureScreenshot') return { data: Buffer.from('png-bytes').toString('base64') }
    return undefined
  }

  const { truncated } = await screenshot(connection, 'S1', { fullPage: true })
  const shot = socket.sent.find((m) => m.method === 'Page.captureScreenshot')
  assert.equal(shot.params.clip.height, 3000)
  assert.equal(truncated, false)
})

test('a pixel check after a click re-captures instead of using the pre-click shot', async () => {
  const { socket, connection } = await connected({ callTimeoutMs: 5000 })
  const shots = [solidPng([0, 0, 0]), solidPng([255, 255, 255])]
  let shotIndex = 0
  socket.responder = (message) => {
    // The click-target probe takes the zero-box DOM-click path, so no Input
    // events are needed.
    if (message.method === 'Runtime.evaluate') return { result: { value: { dom: true } } }
    if (message.method === 'Page.captureScreenshot') {
      return { data: shots[shotIndex++].toString('base64') }
    }
    return undefined
  }

  const results = await runChecks(connection, 'S1', [
    { name: 'before', type: 'pixel', x: 0, y: 0, color: '#000000' },
    { name: 'toggle', click: '#switch', waitMs: 0 },
    { name: 'after', type: 'pixel', x: 0, y: 0, color: '#ffffff' },
  ])

  const captures = socket.sent.filter((m) => m.method === 'Page.captureScreenshot')
  assert.equal(captures.length, 2, 'the post-click pixel check took a fresh screenshot')
  assert.equal(results[0].ok, true)
  assert.equal(results[2].ok, true)
})
