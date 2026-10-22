// strictTabs guard, owned-tab registry, and the small pure helpers exported
// through `__test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, parse, resolve, sep } from 'node:path'
import { BrowserSession, __test } from '../lib/index.js'
import { CdpError } from '../lib/cdp.js'

const { checkWriteTab, clipText, isLocalHost, resolveShotDir } = __test

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
