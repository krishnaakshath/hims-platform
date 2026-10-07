import type { patientAadhaar } from '@/db/schema'
import type { Role } from '@/lib/auth'
import { encryptSensitive } from '@/lib/crypto'
import { normalizeAadhaar, isValidAadhaar, aadhaarLast4, maskAadhaarLast4, redactAadhaarLike } from '@/lib/india/aadhaar'
import { AADHAAR_DECLINE_REASONS, ABHA_UNAVAILABLE_REASONS } from '@/lib/india/reference'
import { AADHAAR_MASKED_READ_ROLES } from '@/lib/role-policy'
import type { AadhaarInput } from '@/lib/validation/patient-registration'

// Aadhaar security boundary (spec §3). The plaintext number exists only in
// the validated input handed to buildAadhaarRow, which encrypts it at once.
// Nothing here returns, logs or throws with the number: summaries/views are
// built from last4 + reason codes only, and audit entries carry actions and
// reason codes only -- never an Aadhaar or ABHA value.

export type NewPatientAadhaarRow = typeof patientAadhaar.$inferInsert

const AADHAAR_DECLINE_CODES: readonly string[] = AADHAAR_DECLINE_REASONS.map((r) => r.code)
const ABHA_UNAVAILABLE_CODES: readonly string[] = ABHA_UNAVAILABLE_REASONS.map((r) => r.code)

export function buildAadhaarRow(patientId: string, input: AadhaarInput, recordedByName: string, now: Date): NewPatientAadhaarRow {
  if (input.status === 'provided') {
    // The zod schema already normalised and validated; re-check so a caller
    // that bypassed it cannot store junk. Fixed messages: never echo input.
    if (input.consent !== true) throw new Error('Patient consent is required to record Aadhaar')
    const number = normalizeAadhaar(String(input.number))
    if (!isValidAadhaar(number)) throw new Error('Invalid Aadhaar number')
    return {
      patientId,
      aadhaarEncrypted: encryptSensitive(number),
      aadhaarLast4: aadhaarLast4(number),
      consentGiven: true,
      consentRecordedAt: now,
      declineReason: null,
      declineNote: null,
      recordedByName,
      updatedAt: now,
    }
  }
  // Same runtime guard for a decline: known reason code, and a non-empty note
  // for 'other'. The note is redacted as defence in depth (the zod schema
  // already rejects a note holding an Aadhaar number).
  if (!(AADHAAR_DECLINE_CODES as readonly unknown[]).includes(input.reason)) throw new Error('Invalid Aadhaar decline reason')
  const declineNote = typeof input.note === 'string' && input.note.trim() !== '' ? redactAadhaarLike(input.note.trim()) : null
  if (input.reason === 'other' && declineNote === null) throw new Error('A note is required when the reason is other')
  return {
    patientId,
    aadhaarEncrypted: null,
    aadhaarLast4: null,
    consentGiven: false,
    consentRecordedAt: null,
    declineReason: input.reason,
    declineNote,
    recordedByName,
    updatedAt: now,
  }
}

// The ON CONFLICT set for an upsert of a buildAadhaarRow result: every column
// is overwritten, so switching declined <-> on_file clears the other side.
// Lives here so this module stays the only one that names the ciphertext
// column (pinned by tests/lib/no-aadhaar-leak.test.ts).
export function aadhaarConflictSet(row: NewPatientAadhaarRow): Omit<NewPatientAadhaarRow, 'patientId'> {
  return {
    aadhaarEncrypted: row.aadhaarEncrypted ?? null,
    aadhaarLast4: row.aadhaarLast4 ?? null,
    consentGiven: row.consentGiven ?? false,
    consentRecordedAt: row.consentRecordedAt ?? null,
    declineReason: row.declineReason ?? null,
    declineNote: row.declineNote ?? null,
    recordedByName: row.recordedByName,
    updatedAt: row.updatedAt ?? new Date(),
  }
}

export type AadhaarStatus = 'on_file' | 'declined' | 'not_recorded'

export interface AadhaarSummary {
  status: AadhaarStatus
  last4: string | null
  declineReason: string | null
  // A Date from the DB, or its ISO string when it came through the JSON cache.
  consentRecordedAt: Date | string | null
  recordedByName: string | null
}

type AadhaarSummarySource = Pick<typeof patientAadhaar.$inferSelect, 'aadhaarLast4' | 'declineReason' | 'recordedByName'> & { consentRecordedAt: Date | string | null }

// The parameter type excludes aadhaarEncrypted; fields are copied explicitly
// so even a whole row passed at runtime cannot carry the ciphertext through.
export function toAadhaarSummary(row: AadhaarSummarySource | null): AadhaarSummary {
  if (!row) return { status: 'not_recorded', last4: null, declineReason: null, consentRecordedAt: null, recordedByName: null }
  // Only ever exactly four digits; anything else (e.g. a full number written
  // by mistake) is dropped rather than shown.
  const last4 = typeof row.aadhaarLast4 === 'string' && /^\d{4}$/.test(row.aadhaarLast4) ? row.aadhaarLast4 : null
  const status: AadhaarStatus = row.aadhaarLast4 != null ? 'on_file' : row.declineReason != null ? 'declined' : 'not_recorded'
  return {
    status,
    last4,
    declineReason: status === 'declined' ? row.declineReason : null,
    consentRecordedAt: row.consentRecordedAt ?? null,
    recordedByName: row.recordedByName ?? null,
  }
}

export interface AadhaarView {
  status: AadhaarStatus
  masked: string | null
  declineReason: string | null
}

// What a viewer may see. Only AADHAAR_MASKED_READ_ROLES get detail: masked
// (`XXXX XXXX 1234`) when on file, the decline reason code when declined.
// Every other role (and any unknown role, allowlist) gets the status alone.
export function toAadhaarView(summary: AadhaarSummary, role: Role): AadhaarView {
  if (!AADHAAR_MASKED_READ_ROLES.includes(role)) return { status: summary.status, masked: null, declineReason: null }
  const masked = summary.status === 'on_file' && summary.last4 !== null && /^\d{4}$/.test(summary.last4)
    ? maskAadhaarLast4(summary.last4)
    : null
  return {
    status: summary.status,
    masked,
    declineReason: summary.status === 'declined' ? summary.declineReason : null,
  }
}

export interface IdentitySnapshot {
  aadhaarStatus: AadhaarStatus
  aadhaarDeclineReason: string | null
  abhaNumber: string | null
  abhaAddress: string | null
  abhaUnavailableReason: string | null
  isMlc: boolean
}

export interface IdentityAuditEntry { action: string; details: string | null }

// Only a known reason code ever reaches audit details.
function reasonDetails(code: string | null, known: readonly string[]): string {
  return `reason: ${code !== null && known.includes(code) ? code : 'unknown'}`
}

function valueChange(label: string, before: string | null, after: string | null): IdentityAuditEntry[] {
  if (before === after) return []
  if (before === null) return [{ action: `set ${label}`, details: null }]
  if (after === null) return [{ action: `removed ${label}`, details: null }]
  return [{ action: `changed ${label}`, details: null }]
}

// Audit entries for an identity change. before === null means registration:
// everything present in `after` is reported as set/recorded. Aadhaar entries
// appear only when Aadhaar was actually written (aadhaarWritten) or at
// registration. No entry ever contains an Aadhaar or ABHA value.
export function identityAuditEntries(before: IdentitySnapshot | null, after: IdentitySnapshot, aadhaarWritten: boolean): IdentityAuditEntry[] {
  const entries: IdentityAuditEntry[] = []

  if (aadhaarWritten || before === null) {
    if (after.aadhaarStatus === 'on_file') {
      entries.push({ action: before?.aadhaarStatus === 'on_file' ? 'replaced Aadhaar' : 'recorded Aadhaar with consent', details: null })
    } else if (after.aadhaarStatus === 'declined') {
      entries.push({ action: 'recorded Aadhaar decline', details: reasonDetails(after.aadhaarDeclineReason, AADHAAR_DECLINE_CODES) })
    }
  }

  entries.push(...valueChange('ABHA number', before?.abhaNumber ?? null, after.abhaNumber))
  entries.push(...valueChange('ABHA address', before?.abhaAddress ?? null, after.abhaAddress))

  if (after.abhaUnavailableReason !== null && after.abhaUnavailableReason !== (before?.abhaUnavailableReason ?? null)) {
    entries.push({ action: 'recorded ABHA unavailable', details: reasonDetails(after.abhaUnavailableReason, ABHA_UNAVAILABLE_CODES) })
  }

  const wasMlc = before?.isMlc ?? false
  if (!wasMlc && after.isMlc) entries.push({ action: 'set MLC flag', details: null })
  if (wasMlc && !after.isMlc) entries.push({ action: 'cleared MLC flag', details: null })

  return entries
}
