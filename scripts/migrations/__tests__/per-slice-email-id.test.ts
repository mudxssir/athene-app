// ============================================================
// P3-7 safety test: isOldPerSliceEmailId must match ONLY the old per-slice email
// external_ids and NEVER the new P3-5/P3-8/P3-9 schemes — a false positive here
// would delete live calendar/thread-parent/one-chunk-per-email documents.
// ============================================================

import { describe, it, expect } from 'vitest'
import { isOldPerSliceEmailId } from '@/scripts/migrations/delete-per-slice-emails'

describe('isOldPerSliceEmailId (P3-7)', () => {
  it('matches OLD per-slice email ids', () => {
    expect(isOldPerSliceEmailId('gmail:18fabc:0')).toBe(true)
    expect(isOldPerSliceEmailId('gmail:18fabc:12')).toBe(true)
    expect(isOldPerSliceEmailId('ms_email_AAAkAD:0')).toBe(true)
    expect(isOldPerSliceEmailId('ms_email_AAAkAD:7')).toBe(true)
  })

  it('does NOT match the new P3-5 one-chunk-per-email ids', () => {
    expect(isOldPerSliceEmailId('gmail:18fabc')).toBe(false)
    expect(isOldPerSliceEmailId('ms_email_AAAkAD')).toBe(false)
  })

  it('does NOT match P3-9 calendar ids', () => {
    expect(isOldPerSliceEmailId('gmail:18fabc:ical:0')).toBe(false)
    expect(isOldPerSliceEmailId('gmail:18fabc:ical:1')).toBe(false)
  })

  it('does NOT match P3-8 thread-parent ids', () => {
    expect(isOldPerSliceEmailId('gmail:thread:t-9')).toBe(false)
    expect(isOldPerSliceEmailId('ms_email:thread:conv-1')).toBe(false)
  })

  it('does NOT match unrelated documents', () => {
    expect(isOldPerSliceEmailId('drive:abc123')).toBe(false)
    expect(isOldPerSliceEmailId('ms_drive_xyz')).toBe(false)
    expect(isOldPerSliceEmailId('ms_sharepoint_doc:0')).toBe(false) // not gmail/ms_email prefix
    expect(isOldPerSliceEmailId('notion:page-1')).toBe(false)
  })
})
