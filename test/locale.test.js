// Locale contract tests: DSH reads a plugin's display text and its detail
// document from `locale/<language>.json` resolved through the package exports,
// so these files are what make the plugin follow the DSH language setting. The
// client half keeps its own dictionaries; they must stay paired. No browser,
// no socket.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const readText = (path) => readFileSync(join(root, path), 'utf8')
const readJson = (path) => JSON.parse(readText(path))
const pkg = readJson('package.json')
const CJK = /[\u4e00-\u9fff]/u

test('package ships the locale files and the Chinese README', () => {
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.ok(pkg.files.includes('locale'), 'files must include the locale directory')
  assert.ok(pkg.files.includes('README.zh.md'), 'files must include README.zh.md')
})

test('the locale files resolve through the package exports', () => {
  // This is the exact lookup DSH performs; without the exports entry it catches
  // ERR_PACKAGE_PATH_NOT_EXPORTED and silently falls back to the package fields.
  assert.match(import.meta.resolve('@dougen/dsh-cdp/locale/en.json'), /\/locale\/en\.json$/u)
  assert.match(import.meta.resolve('@dougen/dsh-cdp/locale/zh.json'), /\/locale\/zh\.json$/u)
})

test('each locale declares display text in its own language', () => {
  const en = readJson('locale/en.json')
  const zh = readJson('locale/zh.json')
  for (const meta of [en.meta, zh.meta]) {
    assert.equal(typeof meta.title, 'string')
    assert.notEqual(meta.title.trim(), '')
    assert.equal(typeof meta.description, 'string')
    assert.notEqual(meta.description.trim(), '')
  }
  assert.equal(zh.meta.title, '控制浏览器')
  assert.match(zh.meta.title, CJK)
  assert.match(zh.meta.description, CJK)
  assert.doesNotMatch(en.meta.title, CJK)
  assert.doesNotMatch(en.meta.description, CJK)
  // The manifest description is the English fallback DSH uses when no locale
  // file is readable, so it must not carry mixed-language copy.
  assert.doesNotMatch(pkg.description, CJK)
})

test('each locale selects a README that exists inside the package', () => {
  const selected = {
    'locale/en.json': 'README.md',
    'locale/zh.json': 'README.zh.md',
  }
  for (const [file, document] of Object.entries(selected)) {
    const detail = readJson(file).meta.detail
    assert.equal(detail, document)
    const target = resolve(root, detail)
    const inside = relative(root, target)
    assert.ok(inside !== '' && !inside.startsWith('..') && !isAbsolute(inside), `${detail} must stay inside the package`)
    assert.ok(existsSync(target), `${detail} is missing`)
  }
})

test('locale resources carry no BOM or zero-width space', () => {
  for (const file of ['locale/en.json', 'locale/zh.json', 'README.md', 'README.zh.md']) {
    const text = readText(file)
    assert.ok(!text.startsWith('\uFEFF'), `${file} starts with a BOM`)
    assert.ok(!text.includes('\u200B'), `${file} contains a zero-width space`)
  }
})

test('each README carries one language', () => {
  const en = readText('README.md')
  const zh = readText('README.zh.md')
  assert.ok(en.startsWith('# @dougen/dsh-cdp'))
  assert.ok(zh.startsWith('# @dougen/dsh-cdp'))
  assert.match(en, /\[中文\]\(README\.zh\.md\)/u)
  assert.match(zh, /\[English\]\(README\.md\)/u)
  assert.ok(!en.includes('## 中文'), 'README.md still carries the Chinese section')
  assert.match(zh, /## 一、它做什么/u)
})

test('client dictionaries stay paired and the non-Chinese fallback is English', () => {
  const source = readText('lib/client.js')
  const dictionary = (name) => {
    const match = source.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\t\\t\\};`, 'u'))
    assert.ok(match, `${name} dictionary not found in lib/client.js`)
    return JSON.parse(`{${match[1].replace(/,\s*$/u, '')}}`)
  }
  const zh = dictionary('ZH')
  const en = dictionary('EN')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of Object.keys(zh)) {
    assert.equal(typeof zh[key], 'string', `ZH.${key}`)
    assert.notEqual(zh[key], '', `ZH.${key} is empty`)
    assert.equal(typeof en[key], 'string', `EN.${key}`)
    assert.notEqual(en[key], '', `EN.${key} is empty`)
  }
  assert.match(zh.title, CJK)
  assert.doesNotMatch(en.title, CJK)
  assert.ok(source.includes('function langOf(active)'))
  assert.ok(source.includes('? "zh" : "en"'))
  assert.ok(!source.includes('snap.active === "en" ? "en" : "zh"'), 'non-Chinese locales must not fall back to Chinese')
})
