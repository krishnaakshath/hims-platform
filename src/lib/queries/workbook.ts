import { ageOnDate, istDateOf, todayIsoIn } from '@/lib/india-time'
import { getDb } from '@/db/client'
import { patients, diagnoses, medicationEpisodes } from '@/db/schema'
import { getOrSetCache, workbookListCacheKey } from '@/lib/cache'
import { publicPatientColumns } from '@/lib/queries/patient-columns'

// One row per patient, covering the columns of the source IPMG
// pre-screening workbook (Symbiosys_IPMG_Prescreening_Proposal.pdf) --
// distinct from the Patient Detail page (one patient, screening-focused)
// and from the "Verification Workbook" export (a nurse's call-prep sheet
// with only the fields relevant to confirming identity on a call). This is
// the literal heading grid (originally 30 headings, now 29 -- see the
// FULL_WORKBOOK_COLUMNS comment in excel-export.ts for why 'Link Tebra' was
// dropped), and its Excel export (buildFullWorkbookXlsx) must render
// exactly these same fields in the same order so the in-app view and the
// download always agree.
export interface WorkbookRow {
  id: string // 1. Anonymous Number
  dateAdded: string // 2. Date Added to Tab
  patientName: string // 3. Patient Name
  currentProvider: string | null // 4. Current Provider
  ratingScales: string // 5. Rating Scales
  dob: string // 6. DOB
  age: number // 7. Age (derived from DOB, never stored)
  city: string | null // 8. City
  zip: string | null // 9. Zip
  phone: string | null // 10. Phone
  dxCodes: string // 11. Dx Codes
  lastCommunication: string | null // 12. Last Communication
  referralType: string | null // 13. Referral Type
  availability: string | null // 14. Availability
  apptDates: string // 15. Past & Future Appt Date
  commConsent: string // 16. Comm Consent Signed/Pref/IntakeQ
  formNotes: string | null // 17. Form Notes
  reviewerNotes: string | null // 18. Reviewer Notes
  clinicianReviewerNotes: string | null // 19. Clinician Reviewer Notes
  piRecommendation: string | null // 20. PI Recommendation
  activeMeds: string // 21. Active Meds
  inactiveMeds: string // 22. Inactive Meds
  oldNotes: string | null // 23. old notes extra space
  oldRecs: string | null // 24. old recs extra space
  // 25 ("LINK TEBRA") was dropped -- patients.tebraChartUrl no longer
  // exists (removed outright by the unified-patient-record migration, not
  // unified into a single-sourced column), so there is no data left to
  // populate it with.
  intakeqEmail: string | null // 26. IntakeQ Email
  patientEmail: string | null // 27. pt email
  outsideMedsConfirmation: string | null // 28. Meds List from pharmacy extra confirmation
  templateDocUrl: string | null // 29. Template Word Doc in SharePoint
  prescreeningSentDate: string | null // 30. Research Depression Prescreening Sent Date
}

export function calculateAge(dob: string): number {
  // Age on today's IST calendar date.
  return ageOnDate(dob, todayIsoIn())
}

export async function listWorkbookRows(): Promise<WorkbookRow[]> {
  return getOrSetCache(workbookListCacheKey(), 30, async () => {
    const db = getDb()
    const allPatients = await db.select(publicPatientColumns).from(patients).orderBy(patients.id)
    const allDx = await db.select().from(diagnoses)
    const allMeds = await db.select().from(medicationEpisodes)

    return allPatients.map((p): WorkbookRow => {
      const dx = allDx.filter((d) => d.patientId === p.id)
      const meds = allMeds.filter((m) => m.patientId === p.id)
      const dob = p.dob

      return {
        id: p.id,
        dateAdded: istDateOf(new Date(p.dateAdded)),
        patientName: p.name,
        currentProvider: p.currentProvider,
        ratingScales: (p.ratingScales ?? []).map((r) => `${r.name}: ${r.score} (${r.date})`).join('; '),
        dob,
        age: calculateAge(dob),
        city: p.city,
        zip: p.zip,
        phone: p.phone,
        dxCodes: dx.map((d) => `${d.code}: ${d.description}`).join('; '),
        lastCommunication: p.lastCommunication,
        referralType: p.referralType,
        availability: p.availability,
        apptDates: [p.lastApptDate ? `Past: ${p.lastApptDate}` : null, p.nextApptDate ? `Next: ${p.nextApptDate}` : null].filter(Boolean).join(' / '),
        commConsent: `${p.commConsentSigned ? 'Signed' : 'Not signed'}${p.commConsentPref ? ` (${p.commConsentPref})` : ''}`,
        formNotes: p.formNotes,
        reviewerNotes: p.reviewerNotes,
        clinicianReviewerNotes: p.clinicianReviewerNotes,
        piRecommendation: p.piRecommendation,
        activeMeds: meds.filter((m) => m.status === 'active').map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''}`).join('; '),
        inactiveMeds: meds.filter((m) => m.status === 'inactive').map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''}`).join('; '),
        oldNotes: p.oldNotes,
        oldRecs: p.oldRecs,
        // patients.email is single-sourced (Task 1 of the unified-patient-record
        // plan) -- both output columns below point at the same value now,
        // matching the same "keep the external contract's two columns, point
        // them at one source" call made for the report table's homePhone/
        // mobilePhone columns elsewhere in this plan.
        intakeqEmail: p.email,
        patientEmail: p.email,
        outsideMedsConfirmation: p.outsideMedsConfirmation,
        templateDocUrl: p.templateDocUrl,
        prescreeningSentDate: p.prescreeningSentDate,
      }
    })
  })
}
