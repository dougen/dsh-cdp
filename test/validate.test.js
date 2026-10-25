// Validators added while reviewing 0.4.0: parameter shapes that used to be
// accepted silently and produce a misleading result. No browser, no socket.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CdpError, parseKeySpec, modifierMask } from '../lib/cdp.js'
import { __test } from '../lib/index.js'

const { checkWriteTab } = __test

/** A session stub with the bits the validators read. */
function session(config = {}) {
  return {
    config: { strictTabs: true, ...config },
    ownsTab: () => true,
    ownTab: () => {},
    forgetTab: () => {},
  }
}

test('modifierMask rejects an unknown modifier rather than dropping it', () => {
  assert.throws(() => modifierMask(['ctrl', 'hyper']), /unknown modifier "hyper"/)
})

test('parseKeySpec keeps working for the documented forms', () => {
  assert.equal(parseKeySpec('Enter').name, 'Enter')
  assert.equal(parseKeySpec('Ctrl+A').modifiers, 2)
  assert.equal(parseKeySpec('Shift+Tab').modifiers, 8)
})

test('checkWriteTab still refuses an unowned tab', () => {
  const s = { config: { strictTabs: true }, ownsTab: () => false }
  assert.throws(() => checkWriteTab(s, 'click', { tabId: 'OTHER' }), /not opened by this session/)
})

// --- media value vocabulary -------------------------------------------------
// `emulateMedia` is exercised through the CDP layer, so the check below pins the
// behaviour of the validator it delegates to by calling the command path. The
// module under test is imported lazily to keep this file free of a connection.

test('media rejects a value outside the feature vocabulary', async () => {
  const { emulateMedia } = await import('../lib/cdp.js')
  const sent = []
  const connection = { send: async (method, params) => { sent.push({ method, params }) } }
  await assert.rejects(
    emulateMedia(connection, 'S1', { colorScheme: 'darck' }),
    (error) => error instanceof CdpError && /prefers-color-scheme does not accept "darck"/.test(error.message),
  )
  assert.equal(sent.length, 0, 'nothing was sent to the browser')
})

test('media rejects an unknown media type', async () => {
  const { emulateMedia } = await import('../lib/cdp.js')
  const connection = { send: async () => {} }
  await assert.rejects(
    emulateMedia(connection, 'S1', { media: 'prints' }),
    (error) => error instanceof CdpError && /media does not accept "prints"/.test(error.message),
  )
})

test('media accepts the documented values and sends them', async () => {
  const { emulateMedia } = await import('../lib/cdp.js')
  const sent = []
  const connection = { send: async (method, params) => { sent.push({ method, params }) } }
  const result = await emulateMedia(connection, 'S1', { colorScheme: 'dark', reducedMotion: 'reduce', media: 'print' })
  assert.equal(result.colorScheme, 'dark')
  const call = sent.find((c) => c.method === 'Emulation.setEmulatedMedia')
  assert.deepEqual(call.params.features, [
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ])
  assert.equal(call.params.media, 'print')
})

test('media with no arguments clears the overrides', async () => {
  const { emulateMedia } = await import('../lib/cdp.js')
  const sent = []
  const connection = { send: async (method, params) => { sent.push({ method, params }) } }
  await emulateMedia(connection, 'S1', {})
  const call = sent.find((c) => c.method === 'Emulation.setEmulatedMedia')
  assert.equal(call.params.features, undefined, 'an empty feature list means "use the real ones"')
})

// --- wait condition building ------------------------------------------------
// The empty-string case is the one that used to pass silently: a blank selector
// compiles to `querySelector("") !== null`, which is always true.

test('wait refuses entirely empty conditions', async () => {
  const { waitFor } = await import('../lib/cdp.js')
  const connection = { send: async () => ({ result: { value: { ok: true } } }) }
  await assert.rejects(
    waitFor(connection, 'S1', { selector: '' }),
    (error) => error instanceof CdpError && /wait needs one of/.test(error.message),
  )
})

test('wait ignores blank text but keeps the real condition', async () => {
  const { waitFor } = await import('../lib/cdp.js')
  let expression = null
  const connection = {
    send: async (method, params) => {
      expression = params.expression
      return { result: { value: { ok: true, waitedMs: 0 } } }
    },
  }
  await waitFor(connection, 'S1', { text: '', selector: '#app', timeoutMs: 1000 })
  assert.ok(expression.includes('querySelector("#app")'), 'the real selector is in the condition')
  assert.ok(!expression.includes('innerText.includes("")'), 'the blank text was dropped')
})

test('wait reports the elapsed time even when the page reports its own', async () => {
  const { waitFor } = await import('../lib/cdp.js')
  const connection = { send: async () => ({ result: { value: { ok: false, waitedMs: 500 } } }) }
  const result = await waitFor(connection, 'S1', { selector: '#x', timeoutMs: 500 })
  assert.equal(result.ok, false)
  assert.equal(typeof result.elapsedMs, 'number')
})

// --- select value validation ------------------------------------------------

test('select refuses an empty value list instead of reporting success', async () => {
  const { selectOption } = await import('../lib/cdp.js')
  const connection = { send: async () => ({ result: { value: {} } }) }
  await assert.rejects(
    selectOption(connection, 'S1', { selector: '#s', values: [] }),
    (error) => error instanceof CdpError && /select needs at least one value/.test(error.message),
  )
})
