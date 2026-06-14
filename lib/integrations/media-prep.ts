// ============================================================
// lib/integrations/media-prep.ts — P5-1 (media shape: vision captions)
//
// Pure, dependency-free image preprocessing for the caption worker. Everything
// here operates on a Buffer and never touches the network or DB, so it is fully
// unit-testable and safe to run in the worker before any model call.
//
//   · sha256                — content hash for org-wide dedup (repeated-logo skip)
//   · detectImage           — format + dimensions from magic bytes (no decoder)
//   · classifyMedia         — decorative / unsupported / animated / oversized gate
//   · stripExif             — remove EXIF/metadata (privacy) before the model call
//
// Why pure TS (no sharp/jimp): adding a native image library complicates the
// serverless deploy for marginal gain — the vision models downscale internally,
// so pixel-resizing is a cost optimization, not a correctness requirement. EXIF
// stripping (the privacy-critical step the playbook calls out) IS done for real
// here. True downscale-before-send (≤2048px) needs a decoder and is deferred to
// the sidecar's Pillow lane (documented in P5_TRACKER) — gated by MAX_IMAGE_BYTES
// so an oversized image is skipped-with-reason, never sent unbounded.
// ============================================================

import { createHash } from 'crypto'

// ── Tunables ────────────────────────────────────────────────────────────────

/** Below this, an image is treated as decorative (icon/spacer/logo) and skipped. */
export const DECORATIVE_MAX_BYTES = 10 * 1024 // 10 KB (PLAN_A media edge case)

/**
 * Hard ceiling on bytes sent to a vision model. We cannot safely downscale in
 * pure TS, so anything larger is skipped-with-reason rather than sent unbounded.
 * (Sidecar Pillow downscale is the documented follow-up that raises this.)
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024 // 20 MB

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'unknown'

/** Formats we can caption today (static raster). */
const SUPPORTED_FORMATS: ReadonlySet<ImageFormat> = new Set<ImageFormat>([
  'jpeg',
  'png',
  'gif',
  'webp',
])

export interface DetectedImage {
  format: ImageFormat
  width: number | null
  height: number | null
  animated: boolean
}

/** SHA-256 hex of the raw bytes (org-wide dedup key). */
export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

// ── Format + dimension detection (magic bytes only) ──────────────────────────

function readUInt16BE(buf: Buffer, off: number): number {
  return buf.length >= off + 2 ? buf.readUInt16BE(off) : 0
}

/** JPEG: walk segments to the first SOF marker for width/height. */
function detectJpeg(buf: Buffer): { width: number | null; height: number | null } {
  let off = 2 // past SOI (0xFFD8)
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off++
      continue
    }
    const marker = buf[off + 1]
    // SOF0..SOF15 (excluding DHT 0xC4, JPG 0xC8, DAC 0xCC) carry frame dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = readUInt16BE(buf, off + 5)
      const width = readUInt16BE(buf, off + 7)
      return { width: width || null, height: height || null }
    }
    // Standalone markers (no length): RSTn / SOI / EOI / TEM.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2
      continue
    }
    const segLen = readUInt16BE(buf, off + 2)
    if (segLen < 2) break
    off += 2 + segLen
  }
  return { width: null, height: null }
}

/** Detect format + dimensions + animation from the file header. */
export function detectImage(buf: Buffer): DetectedImage {
  if (buf.length < 12) return { format: 'unknown', width: null, height: null, animated: false }

  // PNG: 89 50 4E 47 0D 0A 1A 0A ; IHDR width/height at bytes 16/20.
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return {
      format: 'png',
      width: buf.length >= 24 ? buf.readUInt32BE(16) : null,
      height: buf.length >= 24 ? buf.readUInt32BE(20) : null,
      animated: buf.includes(Buffer.from('acTL')), // APNG animation control chunk
    }
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const { width, height } = detectJpeg(buf)
    return { format: 'jpeg', width, height, animated: false }
  }

  // GIF: "GIF87a" / "GIF89a" ; logical-screen width/height little-endian at 6/8.
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const width = buf.readUInt16LE(6)
    const height = buf.readUInt16LE(8)
    // Animated if more than one image-descriptor (0x2C) follows — cheap heuristic:
    // GIF89a with a NETSCAPE/ANIM app-extension, or >1 frame separator.
    let frames = 0
    for (let i = 13; i < buf.length - 1 && frames < 2; i++) {
      if (buf[i] === 0x2c) frames++
    }
    return { format: 'gif', width, height, animated: frames > 1 }
  }

  // WebP: "RIFF"...."WEBP" ; animated when the "ANIM" chunk is present.
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return {
      format: 'webp',
      width: null, // VP8/VP8L/VP8X dimension parsing omitted (not needed for the gate)
      height: null,
      animated: buf.includes(Buffer.from('ANIM')),
    }
  }

  return { format: 'unknown', width: null, height: null, animated: false }
}

// ── Classification gate ──────────────────────────────────────────────────────

export type MediaDecision =
  | { action: 'caption'; format: ImageFormat }
  | { action: 'skip'; reason: MediaSkipReason }

export type MediaSkipReason =
  | 'decorative'        // < DECORATIVE_MAX_BYTES (icon/spacer/logo)
  | 'unsupported_format'
  | 'animated'          // animated GIF / WebP / APNG — first-frame caption deferred
  | 'oversized_image'   // > MAX_IMAGE_BYTES, cannot downscale in pure TS
  | 'empty'

/**
 * Decide whether a fetched image should be captioned. Order matters: empty →
 * decorative → format → animated → oversized. Decorative is checked before
 * format so a 200-byte tracking pixel is cheaply skipped regardless of format.
 */
export function classifyMedia(buf: Buffer): MediaDecision {
  if (buf.length === 0) return { action: 'skip', reason: 'empty' }
  if (buf.length < DECORATIVE_MAX_BYTES) return { action: 'skip', reason: 'decorative' }

  const det = detectImage(buf)
  if (!SUPPORTED_FORMATS.has(det.format)) return { action: 'skip', reason: 'unsupported_format' }
  if (det.animated) return { action: 'skip', reason: 'animated' }
  if (buf.length > MAX_IMAGE_BYTES) return { action: 'skip', reason: 'oversized_image' }

  return { action: 'caption', format: det.format }
}

// ── EXIF / metadata stripping (privacy) ──────────────────────────────────────

/**
 * Strip metadata that can carry PII (GPS coordinates, device, timestamps) before
 * the image leaves our boundary for the vision model.
 *   · JPEG — drop APP1..APP15 (EXIF/XMP/ICC-in-APP2 is re-derivable) + COM; keep
 *            SOI, APP0 (JFIF), the frame, and the entropy-coded data verbatim.
 *   · PNG  — drop ancillary text/metadata chunks (eXIf, tEXt, zTXt, iTXt).
 *   · gif/webp/unknown — pass through (no cheap GPS-bearing metadata to strip).
 * Returns the input unchanged on any parse anomaly (never throws, never corrupts).
 */
export function stripExif(buf: Buffer, format?: ImageFormat): Buffer {
  const fmt = format ?? detectImage(buf).format
  try {
    if (fmt === 'jpeg') return stripJpegMetadata(buf)
    if (fmt === 'png') return stripPngMetadata(buf)
  } catch {
    return buf
  }
  return buf
}

function stripJpegMetadata(buf: Buffer): Buffer {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf
  const out: Buffer[] = [buf.subarray(0, 2)] // SOI
  let off = 2
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) break // not at a marker — bail, keep what we have + tail
    const marker = buf[off + 1]
    // Start of Scan — everything after is compressed image data; copy verbatim.
    if (marker === 0xda) {
      out.push(buf.subarray(off))
      return Buffer.concat(out)
    }
    const segLen = readUInt16BE(buf, off + 2)
    if (segLen < 2 || off + 2 + segLen > buf.length) break
    const isMetadata =
      (marker >= 0xe1 && marker <= 0xef) || // APP1..APP15 (EXIF/XMP/ICC/…)
      marker === 0xfe // COM comment
    if (!isMetadata) out.push(buf.subarray(off, off + 2 + segLen))
    off += 2 + segLen
  }
  // Parse stalled before SOS — safest is to return the original untouched.
  return out.length > 1 ? Buffer.concat([...out, buf.subarray(off)]) : buf
}

const PNG_STRIP_CHUNKS: ReadonlySet<string> = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt'])

function stripPngMetadata(buf: Buffer): Buffer {
  if (buf.length < 8) return buf
  const out: Buffer[] = [buf.subarray(0, 8)] // signature
  let off = 8
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const total = 12 + len // length(4) + type(4) + data(len) + crc(4)
    if (off + total > buf.length) break
    if (!PNG_STRIP_CHUNKS.has(type)) out.push(buf.subarray(off, off + total))
    off += total
    if (type === 'IEND') break
  }
  return Buffer.concat(out)
}
