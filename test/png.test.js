// PNG decode / colour helpers — pure functions, exercised with PNGs the test
// itself encodes (deflate + CRC), so no fixtures and no browser needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { decodePng, parseColor, samplePixel, nearColor } from '../lib/cdp.js'

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

/** Build an RGBA PNG from already-filtered scanlines (filter byte included). */
function png(width, height, scanlines) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(scanlines))), chunk('IEND', Buffer.alloc(0))])
}

/** One filter-0 scanline of `pixels` (RGBA triples-with-alpha as flat arrays). */
function row0(bytes) {
  return Buffer.concat([Buffer.from([0]), Buffer.from(bytes)])
}

test('decodePng round-trips a filter-0 RGBA image', () => {
  const w = 2
  const h = 1
  const bytes = [255, 0, 0, 255, 0, 255, 0, 255]
  const image = decodePng(png(w, h, [row0(bytes)]))
  assert.equal(image.width, w)
  assert.equal(image.height, h)
  assert.deepEqual([...image.data], bytes)
})

test('decodePng reverses the filter-1 predictor', () => {
  // Filter 1 (Sub): stored[x] = raw[x] - raw[x - bpp]; bpp = 4 for RGBA.
  const w = 2
  const h = 1
  const raw = [255, 10, 10, 255, 5, 250, 5, 255]
  const stored = raw.map((v, i) => (i < 4 ? v : (v - raw[i - 4]) & 0xff))
  const image = decodePng(png(w, h, [Buffer.concat([Buffer.from([1]), Buffer.from(stored)])]))
  assert.deepEqual([...image.data], raw)
})

test('decodePng rejects non-PNG input', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /not a PNG/)
})

test('parseColor accepts every documented form', () => {
  assert.deepEqual(parseColor('#ff0000'), [255, 0, 0])
  assert.deepEqual(parseColor('#f00'), [255, 0, 0])
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3])
  assert.deepEqual(parseColor('rgba(300, 5, 3, 0.5)'), [255, 5, 3])
  assert.deepEqual(parseColor([9, 8, 7]), [9, 8, 7])
  assert.throws(() => parseColor('nope'), /bad colour/)
  assert.throws(() => parseColor([1, 2]), /bad colour/)
})

test('samplePixel maps 0..1 coordinates and clamps out-of-range points', () => {
  const image = { width: 2, height: 2, data: Buffer.from([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255]) }
  assert.deepEqual(samplePixel(image, 0, 0), [1, 0, 0])
  assert.deepEqual(samplePixel(image, 1, 1), [4, 0, 0])
  // 0.5 of a 2-pixel axis rounds to index 1, same as 1 — documented rounding.
  assert.deepEqual(samplePixel(image, 0.5, 0.5), [4, 0, 0])
  assert.deepEqual(samplePixel(image, -5, 99), [3, 0, 0]) // each axis clamps independently
})

test('nearColor honours per-channel tolerance', () => {
  assert.equal(nearColor([10, 10, 10], [10, 10, 10]), true)
  assert.equal(nearColor([10, 10, 10], [25, 10, 10]), true) // exactly 15 apart, tolerance 16
  assert.equal(nearColor([10, 10, 10], [27, 10, 10], 16), false)
  assert.equal(nearColor([0, 0, 0], [0, 0, 17]), false)
})
