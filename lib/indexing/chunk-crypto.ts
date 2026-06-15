// ============================================================
// lib/indexing/chunk-crypto.ts — P7-1 (playbook Phase 7, item 1)
//
// Per-org AES-256-GCM for chunk_text at rest. The key is derived from the master
// KMS key + the internal org id (HMAC-SHA256, the same scheme that protects BYOK
// keys — lib/auth/kms), so a leaked master key alone decrypts nothing without each
// org's UUID, and rotation re-keys via the existing KMS_KEY swap + re-encryption.
//
// Envelope (self-identifying so readers detect ciphertext without a schema change):
//   encv1:<base64(iv[12] || ciphertext || authTag[16])>
//
// GCM gives integrity: a tampered or wrong-key value fails authentication and
// surfaces as null (caller falls back / re-indexes), never as silent garbage.
// Encryption is opt-in via CHUNK_TEXT_ENCRYPTION; when off, callers pass plaintext
// through unchanged (the choke point stays config-only, per the P0 design).
// ============================================================

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { deriveOrgKey, getMasterKey } from '@/lib/auth/kms'
import { logger } from '@/lib/logger'

const PREFIX = 'encv1:'
const IV_LEN = 12
const TAG_LEN = 16

/** True when a stored value is an encrypted envelope. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/** 32-byte AES key for an org (first 32 bytes of the 64-hex derived key). */
function orgKey(orgId: string): Buffer {
  return Buffer.from(deriveOrgKey(getMasterKey(), orgId), 'hex').subarray(0, 32)
}

/**
 * Encrypt plaintext for an org. Returns the `encv1:` envelope, or the original
 * plaintext on any failure (KMS missing, etc.) — encryption must never lose data;
 * a failed encrypt degrades to plaintext-at-rest and is logged.
 */
export function encryptChunkText(plaintext: string, orgId: string): string {
  if (!orgId) return plaintext
  try {
    const iv = randomBytes(IV_LEN)
    const cipher = createCipheriv('aes-256-gcm', orgKey(orgId), iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return PREFIX + Buffer.concat([iv, ct, tag]).toString('base64')
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[chunk-crypto] encrypt failed — storing plaintext')
    return plaintext
  }
}

/**
 * Decrypt an `encv1:` envelope for an org. Returns null on tamper / wrong key /
 * malformed input (the caller treats it as missing text). A plaintext value (no
 * prefix) is returned unchanged — so mixed plaintext/ciphertext rows during a
 * paced re-encryption migration both read correctly.
 */
export function decryptChunkText(value: string, orgId: string): string | null {
  if (!isEncrypted(value)) return value
  if (!orgId) return null
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), 'base64')
    if (buf.length < IV_LEN + TAG_LEN + 1) return null
    const iv = buf.subarray(0, IV_LEN)
    const tag = buf.subarray(buf.length - TAG_LEN)
    const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN)
    const decipher = createDecipheriv('aes-256-gcm', orgKey(orgId), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch (err) {
    // Auth failure (tamper / wrong org key) or malformed envelope.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[chunk-crypto] decrypt failed (tamper / wrong key)')
    return null
  }
}
