import { getDb } from '@/db/client'
import {
  patients, patientTrialScreenings, screeningCriteriaResults, diagnoses, medicationEpisodes, allergies, identityVerifications,
  formSubmissions, formSubmissionConsents, formChartDiscrepancies, reviews, appointments, messages, charges, insuranceClaims, patientStatements, mockPayments, documents, faxes,
  rooms, doctorAssignments, insuranceEligibilityChecks, admissions, admissionTransfers, encounterNotes, medicationAdministrations,
  medicationDispenses, carePlans, carePlanGoals, labOrders, labResults, medications,
  adverseEvents, drugAccountabilityEntries, signatures,
} from '@/db/schema'
import { desc, eq, inArray, or, sql } from 'drizzle-orm'
import { getOrSetCache, invalidateCache, patientListCacheKey, patientDetailCacheKey, dashboardCacheKey, workbookListCacheKey } from '@/lib/cache'
import { listDiscrepanciesForPatient } from '@/lib/queries/discrepancies'
import type { Verdict } from '@/lib/rule-engine'
import type { ChargeStatus } from '@/lib/charge-status'

export interface CriteriaSummary {
  inclusionMet: number
  inclusionTotal: number
  exclusionMet: number
  exclusionTotal: number
}

// `mfaSecretEncrypted` is the patient's encrypted TOTP secret -- only the
// portal login/enrollment routes ever need it, and they read it through
// getPatientMfaState, never through these list/detail queries. Both queries
// below are serialized to JSON (GET /api/patients, GET /api/patients/[anonId],
// Server Component props) and written to the Redis cache, so the column is
// stripped from every row they return rather than riding along in a
// whole-row spread. `mfaEnabled` (a non-sensitive flag the staff UI shows)
// stays.
type PatientRowWithoutMfaSecret = Omit<typeof patients.$inferSelect, 'mfaSecretEncrypted'>

function withoutMfaSecret(row: typeof patients.$inferSelect): PatientRowWithoutMfaSecret {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { mfaSecretEncrypted, ...rest } = row
  return rest
}

export type PatientWithStatus = PatientRowWithoutMfaSecret & { trialId?: string; overallStatus?: Verdict; criteriaSummary?: CriteriaSummary }

/**
 * Shared by the /api/patients route handler and any Server Component that
 * needs this data. Server Components must call this directly rather than
 * `fetch()`-ing the app's own API route — a prior review found that pattern
 * (deriving the outbound fetch's origin from the incoming, client-controlled
 * Host header) let an attacker exfiltrate a live session cookie via a forged
 * Host header. Calling the query directly needs no outbound HTTP request at
 * all, which removes that vulnerability class entirely (and matches Next.js's
 * own guidance: fetch data in Server Components from its source, not via
 * Route Handlers).
 */
export interface PatientNameOption {
  id: string
  name: string
}

// Deliberately NOT `listPatientsWithStatus`: this worktree's `schema.ts`
// still declares patients' pre-unification `nameTebra`/`nameIntakeq` (etc.)
// columns, but a separate, concurrently-running worktree's migration
// (`feature/unified-patient-record`) has already collapsed the live shared
// Neon DB's `patients` table down to a single `name`/`dob` pair -- the same
// standing cross-worktree drift Task 1's report on this plan diagnosed.
// `listPatientsWithStatus`'s bare `patient: patients` select spreads every
// column `schema.ts` declares, including the now-nonexistent
// `name_tebra`/`name_intakeq`, and 42703s against the real live DB. This
// narrow select only ever asks Postgres for `id` and the live table's actual
// `name` column (via a raw `sql` fragment, since `schema.ts` has no typed
// accessor for it), so it works against the DB as it actually is today.
// Used to populate a plain patient <select> (Receive Document modal, inline
// document filing) -- not general patient data, so it doesn't need
// screening/criteria/MFA fields `listPatientsWithStatus` also carries.
export async function listPatientNameOptions(): Promise<PatientNameOption[]> {
  return getDb()
    .select({ id: patients.id, name: sql<string>`patients.name` })
    .from(patients)
    .orderBy(sql`patients.name`)
}

export async function listPatientsWithStatus(trialId: string | null): Promise<PatientWithStatus[]> {
  return getOrSetCache(patientListCacheKey(trialId), 30, async () => {
    const rows = await getDb()
      .select({ patient: patients, screening: patientTrialScreenings })
      .from(patients)
      .leftJoin(patientTrialScreenings, eq(patientTrialScreenings.patientId, patients.id))
      .where(trialId ? eq(patientTrialScreenings.trialId, trialId) : undefined)
      .orderBy(patients.id)

    // Single grouped query for every screening's criteria results, joined
    // back to patientId, so the patient list/cards can show a lightweight
    // "N/M inclusion" readout without an N+1 per-patient criteria lookup.
    const criteriaRows = await getDb()
      .select({
        patientId: patientTrialScreenings.patientId,
        criterionType: screeningCriteriaResults.criterionType,
        verdict: screeningCriteriaResults.verdict,
      })
      .from(screeningCriteriaResults)
      .innerJoin(patientTrialScreenings, eq(screeningCriteriaResults.screeningId, patientTrialScreenings.id))

    const summaryByPatient = new Map<string, CriteriaSummary>()
    for (const row of criteriaRows) {
      const summary = summaryByPatient.get(row.patientId) ?? { inclusionMet: 0, inclusionTotal: 0, exclusionMet: 0, exclusionTotal: 0 }
      const met = row.verdict === 'green'
      // Null criterionType is legacy data written before the column existed
      // -- the UI (and this rollup) treats it the same as 'inclusion'.
      if (row.criterionType === 'exclusion') {
        summary.exclusionTotal += 1
        if (met) summary.exclusionMet += 1
      } else {
        summary.inclusionTotal += 1
        if (met) summary.inclusionMet += 1
      }
      summaryByPatient.set(row.patientId, summary)
    }

    return rows.map((r) => ({
      ...withoutMfaSecret(r.patient),
      trialId: r.screening?.trialId,
      overallStatus: r.screening?.overallStatus,
      criteriaSummary: summaryByPatient.get(r.patient.id),
    }))
  })
}

/**
 * Shared by the /api/patients/[anonId] route handler and the Patient Detail
 * Server Component page — see the comment on `listPatientsWithStatus` above
 * for why Server Components must call this directly rather than fetching
 * the app's own API route.
 */
export async function getPatientDetail(anonId: string) {
  return getOrSetCache(patientDetailCacheKey(anonId), 30, async () => {
    const [patient] = await getDb().select().from(patients).where(eq(patients.id, anonId))
    if (!patient) return null

    const [screening] = await getDb().select().from(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, anonId))
    const criteria = screening ? await getDb().select().from(screeningCriteriaResults).where(eq(screeningCriteriaResults.screeningId, screening.id)) : []
    const dx = await getDb().select().from(diagnoses).where(eq(diagnoses.patientId, anonId))
    const meds = await getDb().select().from(medicationEpisodes).where(eq(medicationEpisodes.patientId, anonId))
    const patientAllergies = await getDb().select().from(allergies).where(eq(allergies.patientId, anonId))
    // Project down to only what callers need. The full row includes
    // `idNumberEncrypted` (encrypted ciphertext of the ID number) and the
    // internal `id`/`patientId` keys -- never decrypted here, but there's no
    // reason to put ciphertext on the wire, in the Redis cache, or into the
    // Excel-export code path's intermediate objects when it's unused.
    const [identity] = await getDb()
      .select({
        idType: identityVerifications.idType,
        verified: identityVerifications.verified,
        verifiedBy: identityVerifications.verifiedBy,
        verifiedAt: identityVerifications.verifiedAt,
      })
      .from(identityVerifications)
      .where(eq(identityVerifications.patientId, anonId))

    const discrepancies = await listDiscrepanciesForPatient(anonId)

    return {
      ...withoutMfaSecret(patient),
      mfaEnabled: patient.mfaEnabled,
      overallStatus: screening?.overallStatus,
      selectionConfirmedAt: screening?.selectionConfirmedAt ?? null,
      selectionConfirmedByName: screening?.selectionConfirmedByName ?? null,
      selectionNotifiedAt: screening?.selectionNotifiedAt ?? null,
      criteria,
      diagnoses: dx,
      medications: meds,
      allergies: patientAllergies,
      identityVerification: identity ?? null,
      portalConfigured: !!patient.portalPasswordHash,
      discrepancies,
    }
  })
}

export interface PharmacyEpisode {
  id: number
  name: string
  medicationClass: string
  dose: string | null
  startDate: string
  stopDate: string | null
  catalogMedicationId: number | null
}

export interface PharmacyPatientView {
  id: string
  name: string
  dob: string
  currentProvider: string | null
  diagnoses: { id: number; code: string; description: string }[]
  activeMedications: PharmacyEpisode[]
  pastMedications: PharmacyEpisode[]
  dispenses: {
    id: number
    medicationId: number
    medicationName: string
    medicationEpisodeId: number | null
    quantity: number
    dispensedByName: string
    dispensedAt: Date
    notes: string | null
    charge: { id: number; status: ChargeStatus; amountCents: number } | null
  }[]
}

/**
 * Narrow, pharmacy-scoped patient projection for the dispensing counter --
 * deliberately NOT `getPatientDetail()`. `getPatientDetail()` returns
 * screening criteria (with evidence quotes), identity-verification records,
 * chart discrepancies and portal-credential state -- none of which a
 * pharmacist confirming a chart and dispensing a drug needs, and all of
 * which is PHI a pharmacy-role session has no business receiving on the wire.
 *
 * Exact-id matching only, case-insensitive after trimming
 * (`lower(trim(id)) = lower(trim(input))`) -- deliberately NOT the fuzzy
 * name+DOB matching front desk's duplicate search uses. Front desk's job is
 * finding candidate duplicates, so fuzzy matching is a feature there; a
 * dispensing counter's job is confirming ONE specific chart before handing
 * over medication, so a near-miss match here would be a dispensing error,
 * not a helpful suggestion.
 *
 * `name`/`dob`: this worktree's schema.ts still declares the patients table
 * with the old split `nameTebra`/`nameIntakeq`/`dobTebra`/`dobIntakeq`
 * columns (see `findLikelyDuplicatePatients` above), but a concurrent
 * worktree (unified-patient-record) has already migrated the live, shared
 * Neon `patients` table to single-sourced `name`/`dob` columns -- confirmed
 * directly against `information_schema.columns`, and confirmed the hard way:
 * every other query in this codebase still doing `nameTebra ?? nameIntakeq`
 * now 500s against the live DB with "column ... does not exist". This
 * worktree's schema.ts has not been reconciled with that migration yet, so
 * `name`/`dob` are selected here as raw SQL fragments against the real
 * column names rather than via schema.ts column objects (adding those
 * columns to the shared schema.ts is unified-patient-record's reconciliation
 * to make, not this task's). `dob::text` casts in SQL so Postgres hands back
 * a plain 'YYYY-MM-DD' string -- without it, node-postgres's default type
 * parser for the `date` OID returns a JS `Date`, not the string this view's
 * shape promises.
 *
 * `catalogMedicationId` is resolved the same way as Task 3's `inCatalog`:
 * one full-catalog fetch (the catalog is ~15 rows), compared
 * case-insensitively in application code rather than a per-episode
 * correlated subquery.
 *
 * `dispenses` left-joins `medications` (for the display name) and `charges`
 * (via `medicationDispenses.chargeId`, Task 1) -- a dispense with no charge
 * yet (a sample, an in-office dose) is a left-join miss, not a row to drop.
 * Ordered `desc(dispensedAt), desc(id))`, same tie-break as
 * `listDispensesForPatient`'s comment in medication-dispenses.ts:74-77:
 * `dispensedAt`'s `defaultNow()` has millisecond resolution, so two
 * near-simultaneous dispenses can share a timestamp.
 *
 * No caching, unlike `getPatientDetail`'s 30s cache -- a pharmacist reading
 * this view needs to see a dispense or a just-logged bill immediately; a
 * stale "not billed yet" at the counter invites a double-bill attempt.
 */
export async function getPatientPharmacyView(patientId: string): Promise<PharmacyPatientView | null> {
  const db = getDb()
  const trimmed = patientId.trim()

  const [patientRow] = await db
    .select({
      id: patients.id,
      name: sql<string>`patients.name`,
      dob: sql<string>`patients.dob::text`,
      currentProvider: patients.currentProvider,
    })
    .from(patients)
    .where(sql`lower(trim(${patients.id})) = lower(trim(${trimmed}))`)
  if (!patientRow) return null

  const dx = await db
    .select({ id: diagnoses.id, code: diagnoses.code, description: diagnoses.description })
    .from(diagnoses)
    .where(eq(diagnoses.patientId, patientRow.id))

  const episodeRows = await db
    .select({
      id: medicationEpisodes.id,
      name: medicationEpisodes.name,
      medicationClass: medicationEpisodes.medicationClass,
      dose: medicationEpisodes.dose,
      startDate: medicationEpisodes.startDate,
      stopDate: medicationEpisodes.stopDate,
      status: medicationEpisodes.status,
    })
    .from(medicationEpisodes)
    .where(eq(medicationEpisodes.patientId, patientRow.id))

  const catalogRows = await db.select({ id: medications.id, name: medications.name }).from(medications)
  const catalogIdByName = new Map(catalogRows.map((m) => [m.name.toLowerCase(), m.id]))

  const toEpisode = (e: (typeof episodeRows)[number]): PharmacyEpisode => ({
    id: e.id,
    name: e.name,
    medicationClass: e.medicationClass,
    dose: e.dose,
    startDate: e.startDate,
    stopDate: e.stopDate,
    catalogMedicationId: catalogIdByName.get(e.name.toLowerCase()) ?? null,
  })

  const activeMedications = episodeRows.filter((e) => e.status === 'active').map(toEpisode)
  const pastMedications = episodeRows.filter((e) => e.status === 'inactive').map(toEpisode)

  const dispenseRows = await db
    .select({
      id: medicationDispenses.id,
      medicationId: medicationDispenses.medicationId,
      medicationName: medications.name,
      medicationEpisodeId: medicationDispenses.medicationEpisodeId,
      quantity: medicationDispenses.quantity,
      dispensedByName: medicationDispenses.dispensedByName,
      dispensedAt: medicationDispenses.dispensedAt,
      notes: medicationDispenses.notes,
      chargeId: charges.id,
      chargeStatus: charges.status,
      chargeAmountCents: charges.amountCents,
    })
    .from(medicationDispenses)
    .leftJoin(medications, eq(medications.id, medicationDispenses.medicationId))
    .leftJoin(charges, eq(charges.id, medicationDispenses.chargeId))
    .where(eq(medicationDispenses.patientId, patientRow.id))
    .orderBy(desc(medicationDispenses.dispensedAt), desc(medicationDispenses.id))

  return {
    id: patientRow.id,
    name: patientRow.name,
    dob: patientRow.dob,
    currentProvider: patientRow.currentProvider,
    diagnoses: dx,
    activeMedications,
    pastMedications,
    dispenses: dispenseRows.map((r) => ({
      id: r.id,
      medicationId: r.medicationId,
      // medicationDispenses.medicationId is a NOT NULL FK to medications.id,
      // so this left-join miss never actually happens -- the fallback exists
      // only to satisfy the join's nullable TS type.
      medicationName: r.medicationName ?? '',
      medicationEpisodeId: r.medicationEpisodeId,
      quantity: r.quantity,
      dispensedByName: r.dispensedByName,
      dispensedAt: r.dispensedAt,
      notes: r.notes,
      charge: r.chargeId != null ? { id: r.chargeId, status: r.chargeStatus as ChargeStatus, amountCents: r.chargeAmountCents! } : null,
    })),
  }
}

export interface PharmacyRosterRow {
  id: string
  name: string
  currentProvider: string | null
  activeMedicationCount: number
}

/**
 * The counter view at /pharmacy/patient-lookup used to be a bare search box
 * -- useless unless a pharmacist already had a patient's RD-#### id memorized
 * or written down. This gives them something to actually look at: every
 * patient who currently has at least one active prescription, so the common
 * case (pulling up today's dispensing queue) is a click, not blind data
 * entry. The by-id search box stays for the less common case of a specific
 * id in hand. Deliberately NOT the full patient roster (pharmacy has no
 * patients-page access at all, see LeftNav) -- only patients pharmacy would
 * plausibly need to dispense for.
 */
export async function listPharmacyPatientRoster(): Promise<PharmacyRosterRow[]> {
  const db = getDb()
  const rows = await db
    .select({
      id: patients.id,
      name: patients.name,
      currentProvider: patients.currentProvider,
      activeMedicationCount: sql<number>`count(${medicationEpisodes.id}) filter (where ${medicationEpisodes.status} = 'active')::int`,
    })
    .from(patients)
    .innerJoin(medicationEpisodes, eq(medicationEpisodes.patientId, patients.id))
    .where(eq(medicationEpisodes.status, 'active'))
    .groupBy(patients.id, patients.name, patients.currentProvider)
    .orderBy(patients.name)
  return rows
}

/**
 * Permanently removes a patient and every row that references it -- for
 * correcting a real mistake (a duplicate chart, a wrong entry), not a
 * routine action. None of these FKs cascade at the DB level (see
 * db/seed.ts's clearExistingData, which deletes in this same
 * children-before-parents order for the same reason), so each table is
 * cleared explicitly; Postgres would otherwise reject the final delete on
 * `patients` with a foreign-key violation. Returns false if the patient
 * doesn't exist, true once every row is gone.
 */
export async function deletePatient(anonId: string): Promise<boolean> {
  const db = getDb()
  const [patient] = await db.select({ id: patients.id }).from(patients).where(eq(patients.id, anonId))
  if (!patient) return false

  const screenings = await db.select({ id: patientTrialScreenings.id, trialId: patientTrialScreenings.trialId }).from(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, anonId))
  const screeningIds = screenings.map((s) => s.id)
  if (screeningIds.length > 0) {
    await db.delete(screeningCriteriaResults).where(inArray(screeningCriteriaResults.screeningId, screeningIds))
  }

  // Looked up here, ahead of the admissions delete further down, because
  // medicationAdministrations must be cleared before medicationEpisodes --
  // medicationAdministrations.medicationEpisodeId is a nullable FK to
  // medicationEpisodes(id) with no ON DELETE action, so Postgres would
  // reject the medicationEpisodes delete below once an administration
  // references an episode (same FK-ordering discipline as the
  // doctorAssignments/appointments note further down).
  const patientAdmissionIds = (await db.select({ id: admissions.id }).from(admissions).where(eq(admissions.patientId, anonId))).map((a) => a.id)
  if (patientAdmissionIds.length > 0) {
    await db.delete(medicationAdministrations).where(inArray(medicationAdministrations.admissionId, patientAdmissionIds))
  }

  await db.delete(formChartDiscrepancies).where(eq(formChartDiscrepancies.patientId, anonId))
  await db.delete(reviews).where(eq(reviews.patientId, anonId))
  await db.delete(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, anonId))
  // medicationDispenses.medicationEpisodeId is a nullable FK to
  // medicationEpisodes(id) with no ON DELETE action -- same ordering hazard
  // as medicationAdministrations above, so dispenses referencing an episode
  // must be cleared before medicationEpisodes itself. (Final whole-branch
  // review of feature/care-plans: medicationDispenses had a direct
  // patient_id FK to patients with no ON DELETE action and was missing from
  // this cascade entirely -- confirmed the third instance of this exact bug
  // class in this function, alongside care_plans below.)
  await db.delete(medicationDispenses).where(eq(medicationDispenses.patientId, anonId))
  await db.delete(medicationEpisodes).where(eq(medicationEpisodes.patientId, anonId))
  await db.delete(diagnoses).where(eq(diagnoses.patientId, anonId))
  // form_submission_consents.form_submission_id references form_submissions
  // with no ON DELETE action, so this patient's consent rows must go before
  // the submissions themselves (same children-before-parents discipline as
  // above). Signatures are polymorphic with no FK and are not touched here,
  // matching how form_submission signatures were already treated.
  const patientSubmissionIds = (await db.select({ id: formSubmissions.id }).from(formSubmissions).where(eq(formSubmissions.patientId, anonId))).map((s) => s.id)
  if (patientSubmissionIds.length > 0) {
    await db.delete(formSubmissionConsents).where(inArray(formSubmissionConsents.formSubmissionId, patientSubmissionIds))
  }
  await db.delete(formSubmissions).where(eq(formSubmissions.patientId, anonId))
  await db.delete(allergies).where(eq(allergies.patientId, anonId))
  await db.delete(identityVerifications).where(eq(identityVerifications.patientId, anonId))
  // doctorAssignments must be deleted before appointments -- doctorAssignments.appointmentId
  // is a nullable FK to appointments(id) with no ON DELETE action, so Postgres would reject
  // the appointments delete below with a foreign-key violation once a doctor assignment
  // references an appointment (see the children-before-parents ordering already used above
  // for screeningCriteriaResults before patientTrialScreenings).
  //
  // admissionTransfers -> admissions -> doctorAssignments -> appointments, in that order:
  // admissionTransfers.admissionId references admissions(id), and admissions itself
  // references both doctorAssignments(id) (createdFromAssignmentId) and appointments(id)
  // (followUpAppointmentId) -- the same FK-ordering discipline applied one level deeper.
  await db.delete(insuranceEligibilityChecks).where(eq(insuranceEligibilityChecks.patientId, anonId))
  await db.delete(encounterNotes).where(eq(encounterNotes.patientId, anonId))
  // documents.admission_id is a nullable FK to admissions(id) with no ON
  // DELETE action -- the same ordering hazard already documented above for
  // medicationAdministrations and doctorAssignments. Documents filed to this
  // patient go first; the update then catches the pathological case of a
  // document filed to someone else (or Unfiled) that still references one of
  // this patient's admissions, which the DB permits even though the routes
  // never create it.
  await db.delete(documents).where(eq(documents.patientId, anonId))
  if (patientAdmissionIds.length > 0) {
    await db.update(documents).set({ admissionId: null }).where(inArray(documents.admissionId, patientAdmissionIds))
  }
  if (patientAdmissionIds.length > 0) {
    await db.delete(admissionTransfers).where(inArray(admissionTransfers.admissionId, patientAdmissionIds))
  }
  await db.delete(admissions).where(eq(admissions.patientId, anonId))
  await db.delete(doctorAssignments).where(eq(doctorAssignments.patientId, anonId))
  await db.delete(appointments).where(eq(appointments.patientId, anonId))
  await db.delete(messages).where(eq(messages.patientId, anonId))
  await db.delete(insuranceClaims).where(eq(insuranceClaims.patientId, anonId))
  await db.delete(mockPayments).where(eq(mockPayments.patientId, anonId))
  await db.delete(patientStatements).where(eq(patientStatements.patientId, anonId))
  await db.delete(charges).where(eq(charges.patientId, anonId))
  await db.delete(faxes).where(eq(faxes.patientId, anonId))
  await db.update(rooms).set({ status: 'available', occupiedByPatientId: null }).where(eq(rooms.occupiedByPatientId, anonId))

  // care_plans.patient_id is a NOT NULL FK to patients(id) with no ON DELETE
  // action (Task 1 of feature/care-plans). This cascade was never updated
  // for it -- deleting a patient with a care plan deleted their whole chart
  // and then failed on the final `DELETE FROM patients` below with a
  // foreign-key violation, leaving a half-deleted patient with orphaned
  // care_plans/care_plan_goals rows. Children (goals) before parent (plans),
  // scoped to this patient, same discipline as the rest of this function.
  const carePlanIds = (await db.select({ id: carePlans.id }).from(carePlans).where(eq(carePlans.patientId, anonId))).map((p) => p.id)
  if (carePlanIds.length > 0) {
    await db.delete(carePlanGoals).where(inArray(carePlanGoals.carePlanId, carePlanIds))
  }
  await db.delete(carePlans).where(eq(carePlans.patientId, anonId))

  // lab_orders.patient_id is a NOT NULL FK to patients(id) with no ON DELETE
  // action, same gap as care_plans/medicationDispenses above. Children
  // (results) before parent (orders), scoped to this patient.
  const labOrderIds = (await db.select({ id: labOrders.id }).from(labOrders).where(eq(labOrders.patientId, anonId))).map((o) => o.id)
  if (labOrderIds.length > 0) {
    await db.delete(labResults).where(inArray(labResults.labOrderId, labOrderIds))
  }
  // documents.lab_order_id is a nullable FK to lab_orders(id) with no ON
  // DELETE action. Documents filed to this patient are already gone (line
  // ~228), but an un-filed document (PATCH { patientId: null }, which clears
  // patientId and leaves labOrderId alone) can still point at one of this
  // patient's orders -- exactly the case the patient-scoped delete above
  // misses and this delete would collide with.
  if (labOrderIds.length > 0) {
    await db.update(documents).set({ labOrderId: null }).where(inArray(documents.labOrderId, labOrderIds))
  }
  await db.delete(labOrders).where(eq(labOrders.patientId, anonId))

  // adverse_events.patient_id (NOT NULL) and drug_accountability_entries.patient_id
  // (nullable) and signatures.patient_id (nullable, policy_acceptance only --
  // see the column's own comment in schema.ts) are all FKs to patients(id)
  // with no ON DELETE action and no children of their own, same gap class as
  // care_plans/lab_orders above (trial-compliance and policy-acceptance
  // shipped after this cascade was last audited).
  await db.delete(adverseEvents).where(eq(adverseEvents.patientId, anonId))
  await db.delete(drugAccountabilityEntries).where(eq(drugAccountabilityEntries.patientId, anonId))
  await db.delete(signatures).where(eq(signatures.patientId, anonId))

  await db.delete(patients).where(eq(patients.id, anonId))

  await invalidateCache(patientDetailCacheKey(anonId))
  await invalidateCache(patientListCacheKey(null))
  await invalidateCache(dashboardCacheKey())
  await invalidateCache(workbookListCacheKey())
  for (const s of screenings) {
    await invalidateCache(patientListCacheKey(s.trialId))
  }

  return true
}

export interface PatientPrintIdentity {
  id: string
  name: string
  dob: string
}

// Scoped patient-identity read for the printable prescription page
// (prescriptions plan, Task 5). `getPatientDetail()`'s bare select() pulls
// in every column schema.ts declares for `patients`, including the
// pre-unification `name_tebra`/`name_intakeq`/`dob_tebra`/`dob_intakeq`
// split -- the live shared Neon DB has already been migrated to plain
// `name`/`dob` (the concurrent, not-yet-merged `unified-patient-record`
// worktree), but this branch's schema.ts hasn't caught up, so that
// whole-row select 42703s against the real DB. This narrow select only
// asks Postgres for `id` and the live table's actual `name`/`dob` columns,
// via raw `sql` fragments since schema.ts has no typed accessor for them
// -- literal column-reference fragments, not interpolated values, so
// there's no injection surface. `dob::text` avoids node-postgres handing
// back a JS `Date` instead of the 'YYYY-MM-DD' string this page prints.
// Matches the identical pattern already reviewed clean in
// pharmacy-dashboard's `getPatientPharmacyView` and document-assignment's
// `listPatientNameOptions`. Deliberately NOT a change to `getPatientDetail`
// or to `schema.ts` -- reconciling `patients` belongs to the
// `unified-patient-record` spec.
export async function getPatientIdentityForPrint(patientId: string): Promise<PatientPrintIdentity | null> {
  const [row] = await getDb()
    .select({ id: patients.id, name: sql<string>`patients.name`, dob: sql<string>`patients.dob::text` })
    .from(patients)
    .where(eq(patients.id, patientId))
  return row ?? null
}

export interface LikelyDuplicatePatient {
  id: string
  name: string
  dob: string
}

export async function findLikelyDuplicatePatients(name: string, dob: string): Promise<LikelyDuplicatePatient[]> {
  const rows = await getDb()
    .select({ id: patients.id, name: patients.name, dob: patients.dob })
    .from(patients)
    .where(eq(patients.dob, dob))

  const needle = name.trim().toLowerCase()
  return rows
    .filter((r) => r.name.toLowerCase().includes(needle) || needle.includes(r.name.toLowerCase()))
    .map((r) => ({ id: r.id, name: r.name, dob: r.dob }))
}
