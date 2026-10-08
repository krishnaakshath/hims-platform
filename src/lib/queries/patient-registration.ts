import { sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, patientContacts, patientAadhaar, identityVerifications } from '@/db/schema'
import { encryptSensitive } from '@/lib/crypto'
import { logAudit } from '@/lib/audit'
import { consumeVerifiedAbha } from './abha-link' // SP8
import type { Session } from '@/lib/auth'
import { buildAadhaarRow, identityAuditEntries, type IdentityAuditEntry } from '@/lib/patient-identity'
import { nextUhid } from '@/lib/queries/uhid'
import type { PatientRegistrationInput } from '@/lib/validation/patient-registration'

export interface RegisteredPatient {
  id: string
  uhid: string
  auditEntries: IdentityAuditEntry[]
}

// Registration is all-or-nothing: the patient row, its contacts, the Aadhaar
// row (value or recorded decline) and the optional KYC document are written
// in ONE transaction. If any insert fails, none of them persist -- in
// particular a patient row can never exist without its Aadhaar row, and the
// UHID drawn for a failed attempt is never on any row. (uhid_seq itself is
// not transactional, so a failed attempt leaves a gap in the sequence; that
// is expected and harmless.)
//
// Its audit rows ('registered patient' plus the identity entries) are written
// on the same transaction. The Aadhaar plaintext only ever reaches
// buildAadhaarRow, which encrypts it immediately. Nothing here logs, and errors propagate unchanged for the
// route to map (ABHA duplicates -> 409) or report generically.
export async function registerPatient(input: PatientRegistrationInput, session: Session): Promise<RegisteredPatient> {
  const recordedByName = session.name
  return getDb().transaction(async (tx) => {
    // Anon IDs are RD-#### sequential: one past the highest id that matches
    // the RD-#### shape. The transaction-scoped advisory lock serialises
    // allocation, so two concurrent registrations cannot compute the same id
    // (the second waits until the first commits or rolls back, then sees its
    // row). Only ids matching ^RD-\d+$ are considered, so a non-conforming
    // id (e.g. a TEST-*-<timestamp> fixture left behind) can never poison the
    // result -- the NaN problem the previous Math.max version guarded against.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('patients.rd_id'))`)
    const res = await tx.execute(sql`select coalesce(max(substring(${patients.id} from '^RD-(\\d+)$')::bigint), 0) + 1 as next from ${patients} where ${patients.id} ~ '^RD-\\d+$'`)
    const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as { next: string | number }[]
    const id = `RD-${String(Number(rows[0].next)).padStart(4, '0')}`

    const uhid = await nextUhid(tx)

    const abhaProvided = input.abha.status === 'provided' ? input.abha : null
    const abhaUnavailable = input.abha.status === 'unavailable' ? input.abha : null

    await tx.insert(patients).values({
      id,
      uhid,
      name: input.name.trim(),
      dob: input.dob,
      gender: input.gender,
      maritalStatus: input.maritalStatus ?? null,
      bloodGroup: input.bloodGroup ?? null,
      occupation: input.occupation ?? null,
      nationality: input.nationality,
      religion: input.religion ?? null,
      preferredLanguage: input.preferredLanguage ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2 ?? null,
      city: input.city,
      district: input.district,
      stateCode: input.stateCode,
      pinCode: input.pinCode,
      // Legacy US `zip` is left null; pinCode replaces it (plan ruling 6).
      zip: null,
      abhaNumber: abhaProvided?.abhaNumber ?? null,
      abhaAddress: abhaProvided?.abhaAddress ?? null,
      abhaUnavailableReason: abhaUnavailable?.reason ?? null,
      abhaUnavailableNote: abhaUnavailable?.note ?? null,
      isMlc: input.isMlc,
      mlcNumber: input.isMlc ? (input.mlcNumber ?? null) : null,
      currentProvider: input.currentProvider ?? null,
      primaryPayerId: input.primaryPayerId ?? null,
      primaryMemberId: input.primaryMemberId ?? null,
      primaryGroupNumber: input.primaryGroupNumber ?? null,
      primaryPlanType: input.primaryPlanType ?? null,
      primarySubscriberName: input.primarySubscriberName ?? null,
      primarySubscriberRelationship: input.primarySubscriberRelationship ?? null,
    })

    if (input.contacts.length > 0) {
      await tx.insert(patientContacts).values(input.contacts.map((c) => ({
        patientId: id,
        kind: c.kind,
        name: c.name,
        relationship: c.relationship,
        phone: c.phone,
        addressText: c.addressText ?? null,
        isPrimary: c.isPrimary ?? false,
      })))
    }

    const aadhaarRow = buildAadhaarRow(id, input.aadhaar, recordedByName, new Date())
    await tx.insert(patientAadhaar).values(aadhaarRow)

    if (input.kyc) {
      await tx.insert(identityVerifications).values({
        patientId: id,
        idType: input.kyc.docType,
        idNumberEncrypted: encryptSensitive(input.kyc.docNumber),
        verified: false,
      })
    }

    const auditEntries = identityAuditEntries(null, {
      aadhaarStatus: aadhaarRow.aadhaarLast4 != null ? 'on_file' : 'declined',
      aadhaarDeclineReason: aadhaarRow.declineReason ?? null,
      abhaNumber: abhaProvided?.abhaNumber ?? null,
      abhaAddress: abhaProvided?.abhaAddress ?? null,
      abhaUnavailableReason: abhaUnavailable?.reason ?? null,
      isMlc: input.isMlc,
    }, true)

    // Audit rows are part of the registration: written on the same
    // transaction, so a failed audit insert rolls the registration back and
    // a rolled-back registration leaves no audit row.
    await logAudit(session, 'registered patient', id, null, tx)
    for (const e of auditEntries) await logAudit(session, e.action, id, e.details, tx)
    // SP8: an ABHA verified with ABDM in this registration is stamped verified (same transaction).
    if (abhaProvided?.flowId) await consumeVerifiedAbha(tx, id, abhaProvided.flowId, abhaProvided.abhaNumber ?? null, session)
    // end SP8

    return { id, uhid, auditEntries }
  })
}
