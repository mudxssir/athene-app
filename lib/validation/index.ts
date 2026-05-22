// ============================================================
// lib/validation/index.ts
//
// Central Zod validation utilities.
//
// Usage:
//   import { z } from 'zod'
//   import { parseBody, uuidSchema, internalRoleSchema } from '@/lib/validation'
//
//   const MySchema = z.object({ id: uuidSchema, role: internalRoleSchema })
//
//   let raw: unknown
//   try { raw = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
//   const parsed = parseBody(MySchema, raw)
//   if (!parsed.success) return parsed.response
//   const { id, role } = parsed.data
// ============================================================

import { z } from 'zod'
import { NextResponse } from 'next/server'

// ─── Shared primitive schemas ──────────────────────────────────────────────

/** Internal Supabase UUID (v4 format) */
export const uuidSchema = z.string().uuid()

/** RFC-5321 email, max 254 chars */
export const emailSchema = z.string().email().max(254)

/** The three internal roles used across RBAC */
export const internalRoleSchema = z.enum(['admin', 'member', 'super_user'])

/** Job type for background workers */
export const jobTypeSchema = z.enum(['incremental', 'full'])

/** Generic non-empty string (stripped) */
export const nonEmptyStringSchema = z.string().min(1).max(500).trim()

// ─── parseBody helper ─────────────────────────────────────────────────────
// Returns typed data on success, or a ready-to-return 400 NextResponse on
// failure. Never throws — all Zod errors are serialised into field-level
// detail so clients know exactly what to fix.

type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; response: NextResponse }

export function parseBody<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): ParseResult<T> {
  const result = schema.safeParse(raw)
  if (!result.success) {
    return {
      success: false,
      response: NextResponse.json(
        {
          error: 'Validation failed',
          details: result.error.flatten().fieldErrors,
        },
        { status: 400 },
      ),
    }
  }
  return { success: true, data: result.data }
}
