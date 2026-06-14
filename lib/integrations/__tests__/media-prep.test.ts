// ============================================================
// lib/integrations/__tests__/media-prep.test.ts — P5-1
//
// Pure image preprocessing: sha dedup key, magic-byte format/dimension detection,
// the decorative/unsupported/animated/oversized classification gate, and
// EXIF/metadata stripping (privacy) — all on synthetic buffers, no I/O.
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  sha256,
  detectImage,
  classifyMedia,
  stripExif,
  DECORATIVE_MAX_BYTES,
  MAX_IMAGE_BYTES,
} from '@/lib/integrations/media-prep'

// ── Synthetic image builders ─────────────────────────────────────────────────

/** PNG signature + IHDR(width,height) + optional ancillary chunks + IEND. */
function makePng(width: number, height: number, extra: Buffer = Buffer.alloc(0), apng = false): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  const ihdr = chunk('IHDR', ihdrData)
  const actl = apng ? chunk('acTL', Buffer.alloc(8)) : Buffer.alloc(0)
  const iend = chunk('IEND', Buffer.alloc(0))
  return Buffer.concat([sig, ihdr, actl, extra, iend])
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4) // CRC not validated by our reader
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, crc])
}

/** JPEG: SOI, APP1(EXIF), APP0(JFIF), SOF0(dims), SOS + scan data, EOI. */
function makeJpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8])
  const app1 = jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPS-secret-payload')]))
  const app0 = jpegSegment(0xe0, Buffer.from('JFIF\0'))
  const sof0Data = Buffer.alloc(15)
  sof0Data.writeUInt16BE(height, 1)
  sof0Data.writeUInt16BE(width, 3)
  const sof0 = jpegSegment(0xc0, sof0Data)
  const sos = Buffer.concat([Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01]), Buffer.from('SCANDATA')])
  const eoi = Buffer.from([0xff, 0xd9])
  return Buffer.concat([soi, app1, app0, sof0, sos, eoi])
}

function jpegSegment(marker: number, body: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head[0] = 0xff
  head[1] = marker
  head.writeUInt16BE(body.length + 2, 2)
  return Buffer.concat([head, body])
}

function makeGif(width: number, height: number, frames = 1): Buffer {
  const header = Buffer.from('GIF89a', 'ascii')
  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(width, 0)
  lsd.writeUInt16LE(height, 2)
  const parts: Buffer[] = [header, lsd]
  for (let i = 0; i < frames; i++) parts.push(Buffer.from([0x2c, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
  parts.push(Buffer.from([0x3b])) // trailer
  return Buffer.concat(parts)
}

function makeWebp(animated = false): Buffer {
  const riff = Buffer.from('RIFF', 'ascii')
  const size = Buffer.alloc(4)
  const webp = Buffer.from('WEBP', 'ascii')
  const body = animated ? Buffer.from('ANIM-frames-here') : Buffer.from('VP8 -static-here')
  return Buffer.concat([riff, size, webp, body])
}

/** Pad a buffer to at least `bytes` so it clears the decorative floor. */
function pad(buf: Buffer, bytes: number): Buffer {
  return buf.length >= bytes ? buf : Buffer.concat([buf, Buffer.alloc(bytes - buf.length)])
}

// ── sha256 ───────────────────────────────────────────────────────────────────

describe('sha256 (P5-1)', () => {
  it('is stable and content-addressed (dedup key)', () => {
    const a = Buffer.from('logo-bytes')
    expect(sha256(a)).toBe(sha256(Buffer.from('logo-bytes')))
    expect(sha256(a)).not.toBe(sha256(Buffer.from('other-bytes')))
    expect(sha256(a)).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ── detectImage ──────────────────────────────────────────────────────────────

describe('detectImage (P5-1)', () => {
  it('reads PNG format + IHDR dimensions', () => {
    const d = detectImage(makePng(800, 600))
    expect(d.format).toBe('png')
    expect(d.width).toBe(800)
    expect(d.height).toBe(600)
    expect(d.animated).toBe(false)
  })

  it('flags APNG as animated', () => {
    expect(detectImage(makePng(64, 64, Buffer.alloc(0), true)).animated).toBe(true)
  })

  it('reads JPEG format + SOF dimensions', () => {
    const d = detectImage(makeJpeg(1024, 768))
    expect(d.format).toBe('jpeg')
    expect(d.width).toBe(1024)
    expect(d.height).toBe(768)
  })

  it('reads GIF dimensions and detects multi-frame animation', () => {
    expect(detectImage(makeGif(320, 240, 1)).animated).toBe(false)
    const anim = detectImage(makeGif(320, 240, 3))
    expect(anim.format).toBe('gif')
    expect(anim.width).toBe(320)
    expect(anim.animated).toBe(true)
  })

  it('detects WebP + animated ANIM chunk', () => {
    expect(detectImage(makeWebp(false)).format).toBe('webp')
    expect(detectImage(makeWebp(true)).animated).toBe(true)
  })

  it('returns unknown for non-image / truncated bytes', () => {
    expect(detectImage(Buffer.from('not an image at all')).format).toBe('unknown')
    expect(detectImage(Buffer.alloc(4)).format).toBe('unknown')
  })
})

// ── classifyMedia ────────────────────────────────────────────────────────────

describe('classifyMedia (P5-1)', () => {
  it('skips empty and decorative (sub-10KB) images', () => {
    expect(classifyMedia(Buffer.alloc(0))).toEqual({ action: 'skip', reason: 'empty' })
    expect(classifyMedia(makePng(16, 16))).toEqual({ action: 'skip', reason: 'decorative' })
  })

  it('captions a real-sized supported image', () => {
    const png = pad(makePng(800, 600), DECORATIVE_MAX_BYTES + 1)
    expect(classifyMedia(png)).toEqual({ action: 'caption', format: 'png' })
  })

  it('skips unsupported formats (above the decorative floor)', () => {
    const blob = pad(Buffer.from('%PDF-1.7 fake'), DECORATIVE_MAX_BYTES + 1)
    expect(classifyMedia(blob)).toEqual({ action: 'skip', reason: 'unsupported_format' })
  })

  it('skips animated images', () => {
    const anim = pad(makeGif(320, 240, 4), DECORATIVE_MAX_BYTES + 1)
    expect(classifyMedia(anim)).toEqual({ action: 'skip', reason: 'animated' })
  })

  it('skips oversized images (cannot downscale in pure TS)', () => {
    // A PNG header on a buffer just over the byte ceiling.
    const big = pad(makePng(8000, 8000), MAX_IMAGE_BYTES + 1)
    expect(classifyMedia(big)).toEqual({ action: 'skip', reason: 'oversized_image' })
  })
})

// ── stripExif ────────────────────────────────────────────────────────────────

describe('stripExif (P5-1, privacy)', () => {
  it('removes the JPEG APP1/EXIF (GPS) segment but keeps image data', () => {
    const jpeg = makeJpeg(1024, 768)
    expect(jpeg.includes(Buffer.from('GPS-secret-payload'))).toBe(true)
    const cleaned = stripExif(jpeg, 'jpeg')
    expect(cleaned.includes(Buffer.from('GPS-secret-payload'))).toBe(false)
    expect(cleaned.includes(Buffer.from('Exif\0\0'))).toBe(false)
    // Scan data + JFIF survive; it is still a valid JPEG (SOI…EOI).
    expect(cleaned.includes(Buffer.from('SCANDATA'))).toBe(true)
    expect(cleaned.includes(Buffer.from('JFIF'))).toBe(true)
    expect(cleaned[0]).toBe(0xff)
    expect(cleaned[1]).toBe(0xd8)
    expect(detectImage(cleaned).format).toBe('jpeg')
    expect(detectImage(cleaned).width).toBe(1024)
  })

  it('removes PNG text/eXIf chunks but keeps IHDR + IEND', () => {
    const withMeta = makePng(640, 480, chunk('tEXt', Buffer.from('Comment\0secret location')))
    expect(withMeta.includes(Buffer.from('secret location'))).toBe(true)
    const cleaned = stripExif(withMeta, 'png')
    expect(cleaned.includes(Buffer.from('secret location'))).toBe(false)
    expect(detectImage(cleaned).format).toBe('png')
    expect(detectImage(cleaned).width).toBe(640)
    expect(cleaned.includes(Buffer.from('IEND'))).toBe(true)
  })

  it('passes through gif/webp/unknown unchanged (never throws/corrupts)', () => {
    const gif = makeGif(100, 100)
    expect(stripExif(gif, 'gif').equals(gif)).toBe(true)
    const junk = Buffer.from('not an image')
    expect(stripExif(junk).equals(junk)).toBe(true)
  })

  it('auto-detects format when not passed', () => {
    const jpeg = makeJpeg(200, 200)
    expect(stripExif(jpeg).includes(Buffer.from('GPS-secret-payload'))).toBe(false)
  })
})
