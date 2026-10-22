// Audit trail: JSONL lines per command, opt-out honoured, per-day file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserSession } from '../lib/index.js'

test('audit appends one JSONL line per entry to a per-day file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cdp-audit-test-'))
  const s = new BrowserSession({}, { audit: true, auditDir: dir })

  await s.audit({ ts: '2026-10-22T01:00:00.000Z', cmd: 'open', tabId: null, ok: true, error: null, ms: 12 })
  await s.audit({ ts: '2026-10-22T01:00:01.000Z', cmd: 'click', tabId: 'A', ok: false, error: 'covered', ms: 3 })

  const files = await readdir(dir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/)
  const lines = (await readFile(join(dir, files[0]), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]), { ts: '2026-10-22T01:00:00.000Z', cmd: 'open', tabId: null, ok: true, error: null, ms: 12 })
  assert.equal(JSON.parse(lines[1]).cmd, 'click')
})

test('audit writes nothing when disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cdp-audit-test-'))
  const s = new BrowserSession({}, { audit: false, auditDir: dir })
  await s.audit({ cmd: 'open', ok: true })
  assert.deepEqual(await readdir(dir), [])
})
