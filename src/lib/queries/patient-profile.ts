import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, patientContacts, patientAadhaar } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { aadhaarConflictSet, identityAuditEntries, toAadhaarSummary, type IdentitySnapshot, type NewPatientAadhaarRow } from '@/lib/patient-identity'
import type { ContactInput, PatientProfileUpdateInput } from '@/lib/validation/patient-registration'

// Post-registration writes to the patient master (SP1). Each write runs in
// ONE transaction together with its audit rows, so a change and its audit
// commit or roll back together (same contract as registerPatient). The
// identity "before" snapshot used for the audit diff is read inside that
// transaction with the patient row locked, so concurrent edits cannot
// produce a wrong set-/changed-/removed- entry.
//
// Aadhaar: only aadhaarLast4 / declineReason (and the summary fields) are
// ever selected here -- never the ciphertext. Nothing here logs; errors
// propagate unchanged for the route to map or report by pg code only.

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]
type Executor = ReturnType<typeof getDb> | Tx

async function readIdentity(db: Executor, anonId: string, lock: boolean): Promise<{ dob: string; snapshot: IdentitySnapshot } | null> {
  const q = db.select({
    dob: patients.dob,
    abhaNumber: patients.abhaNumber,
    abhaAddress: patients.abhaAddress,
    abhaUnavailableReason: patients.abhaUnavailableReason,
    isMlc: patients.isMlc,
  }).from(patients).where(eq(patients.id, anonId))
  const [p] = lock ? await q.for('update') : await q
  if (!p) return null
  const [a] = await db.select({
    aadhaarLast4: patientAadhaar.aadhaarLast4,
    declineReason: patientAadhaar.declineReason,
    consentRecordedAt: patientAadhaar.consentRecordedAt,
    recordedByName: patientAadhaar.recordedByName,
  }).from(patientAadhaar).where(eq(patientAadhaar.patientId, anonId))
  const summary = toAadhaarSummary(a ?? null)
  return {
    dob: p.dob,
    snapshot: {
      aadhaarStatus: summary.status,
      aadhaarDeclineReason: summary.declineReason,
      abhaNumber: p.abhaNumber,
      abhaAddress: p.abhaAddress,
      abhaUnavailableReason: p.abhaUnavailableReason,
      isMlc: p.isMlc,
    },
  }
}

export async function getIdentitySnapshot(anonId: string): Promise<{ dob: string; snapshot: IdentitySnapshot } | null> {
  return readIdentity(getDb(), anonId, false)
}

// Status-only probe for viewers that may know nothing more than "on file"
// (the patient portal). Selects last4 solely to test presence; returns a bool.
export async function isAadhaarOnFile(anonId: string): Promise<boolean> {
  const [a] = await getDb().select({ aadhaarLast4: patientAadhaar.aadhaarLast4 }).from(patientAadhaar).where(eq(patientAadhaar.patientId, anonId))
  return a?.aadhaarLast4 != null
}

// false = no such patient (nothing written, nothing audited). Only keys
// present in `input` are written. The schema is .strict() and has no aadhaar
// key, so this can never touch patient_aadhaar. ABHA `provided` sets
// number/address (an omitted one becomes null) and clears the unavailable
// reason/note; `unavailable` does the reverse. Clearing the MLC flag clears
// its number.
export async function updatePatientProfile(anonId: string, input: PatientProfileUpdateInput, session: Session): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const before = await readIdentity(tx, anonId, true)
    if (!before) return false

    const { abha, ...demographics } = input
    const set: Partial<typeof patients.$inferInsert> = {}
    for (const [k, v] of Object.entries(demographics)) {
      if (v !== undefined) (set as Record<string, unknown>)[k] = v
    }
    if (input.isMlc === false) set.mlcNumber = null
    if (abha?.status === 'provided') {
      set.abhaNumber = abha.abhaNumber ?? null
      set.abhaAddress = abha.abhaAddress ?? null
      set.abhaUnavailableReason = null
      set.abhaUnavailableNote = null
    } else if (abha?.status === 'unavailable') {
      set.abhaNumber = null
      set.abhaAddress = null
      set.abhaUnavailableReason = abha.reason
      set.abhaUnavailableNote = abha.note ?? null
    }
    if (Object.keys(set).length > 0) await tx.update(patients).set(set).where(eq(patients.id, anonId))

    const after: IdentitySnapshot = {
      ...before.snapshot,
      abhaNumber: set.abhaNumber !== undefined ? set.abhaNumber : before.snapshot.abhaNumber,
      abhaAddress: set.abhaAddress !== undefined ? set.abhaAddress : before.snapshot.abhaAddress,
      abhaUnavailableReason: set.abhaUnavailableReason !== undefined ? set.abhaUnavailableReason : before.snapshot.abhaUnavailableReason,
      isMlc: input.isMlc ?? before.snapshot.isMlc,
    }
    await logAudit(session, 'updated patient profile', anonId, null, tx)
    for (const e of identityAuditEntries(before.snapshot, after, false)) await logAudit(session, e.action, anonId, e.details, tx)
    return true
  })
}

// Full replace: delete then insert, with the audit row, in one transaction.
// An unknown patient fails the insert's FK and rolls everything back.
export async function replacePatientContacts(anonId: string, contacts: ContactInput[], session: Session): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.delete(patientContacts).where(eq(patientContacts.patientId, anonId))
    if (contacts.length > 0) {
      await tx.insert(patientContacts).values(contacts.map((c) => ({
        patientId: anonId,
        kind: c.kind,
        name: c.name,
        relationship: c.relationship,
        phone: c.phone,
        addressText: c.addressText ?? null,
        isPrimary: c.isPrimary ?? false,
      })))
    }
    await logAudit(session, 'updated patient contacts', anonId, null, tx)
  })
}

// `row` comes from buildAadhaarRow (already encrypted, or a decline with
// both value columns null), so every column is overwritten on conflict --
// switching declined <-> on_file clears the other side. Audit entries are
// computed from status/reason codes only.
export async function upsertPatientAadhaar(anonId: string, row: NewPatientAadhaarRow, session: Session): Promise<void> {
  await getDb().transaction(async (tx) => {
    const before = await readIdentity(tx, anonId, true)
    await tx.insert(patientAadhaar).values({ ...row, patientId: anonId }).onConflictDoUpdate({
      target: patientAadhaar.patientId,
      set: aadhaarConflictSet(row),
    })
    if (!before) return // unreachable in practice: the insert's FK fails first
    const after: IdentitySnapshot = {
      ...before.snapshot,
      aadhaarStatus: row.aadhaarLast4 != null ? 'on_file' : 'declined',
      aadhaarDeclineReason: row.aadhaarLast4 != null ? null : (row.declineReason ?? null),
    }
    for (const e of identityAuditEntries(before.snapshot, after, true)) await logAudit(session, e.action, anonId, e.details, tx)
  })
}
