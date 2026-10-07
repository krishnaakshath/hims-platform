import { getDb } from '@/db/client'
import { patients, patientContacts, patientAadhaar, identityVerifications } from '@/db/schema'
import { encryptSensitive } from '@/lib/crypto'
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
// The Aadhaar plaintext only ever reaches buildAadhaarRow, which encrypts it
// immediately. Nothing here logs, and errors propagate unchanged for the
// route to map (ABHA duplicates -> 409) or report generically.
export async function registerPatient(input: PatientRegistrationInput, recordedByName: string): Promise<RegisteredPatient> {
  return getDb().transaction(async (tx) => {
    // Anon IDs are RD-#### sequential; find the current max and increment.
    // Only consider ids that actually match the RD-#### shape -- Math.max
    // propagates NaN from a single bad operand to its entire result, so any
    // non-conforming id (e.g. a dedicated TEST-*-<timestamp> fixture id left
    // behind by a test that didn't clean itself up) would otherwise
    // permanently poison every future call to "RD-0NaN", which then collides
    // on the unique constraint forever after the first one.
    const existing = await tx.select({ id: patients.id }).from(patients)
    const existingNumbers = existing
      .map((p) => /^RD-(\d+)$/.exec(p.id))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => parseInt(m[1], 10))
    const nextNum = existingNumbers.length === 0 ? 1 : Math.max(...existingNumbers) + 1
    const id = `RD-${String(nextNum).padStart(4, '0')}`

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

    return { id, uhid, auditEntries }
  })
}
