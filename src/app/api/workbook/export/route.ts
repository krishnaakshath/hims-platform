import { NextResponse } from 'next/server'
import { getDb } from '@/db/client'
import { formSubmissions } from '@/db/schema'
import { desc, eq } from 'drizzle-orm'
import { buildWorkbookXlsx, WORKBOOK_EXPORT_CONCURRENCY, type ExportablePatient } from '@/lib/excel-export'
import { mapWithConcurrency } from '@/lib/concurrency'
import { logAudit } from '@/lib/audit'
import { requireSession } from '@/lib/auth'
import { WORKBOOK_EXPORT_ROLES } from '@/lib/role-policy'
import { getPatientDetail, listPatientsWithStatus } from '@/lib/queries/patients'
import { listAllTrials } from '@/lib/queries/trials'

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  // The complete 30-column pre-screening workbook for every patient: admin
  // and crc only (WORKBOOK_EXPORT_ROLES). Narrower than the /workbook page,
  // which pi may view but which hides the download link from pi.
  if (!WORKBOOK_EXPORT_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // `listPatientsWithStatus(null)` (not a raw `select().from(patients)`) so a
  // patient screened against multiple trials appears once per screening, each
  // row carrying its own `trialId`/`overallStatus` — matching what the
  // Patients list view already shows. Per-patient detail (allergies, identity
  // verification, diagnoses, medications, criteria) is filled in below via
  // `getPatientDetail`, the same query the Patient Detail page uses, so this
  // export never duplicates query logic or touches the DB with new SQL.
  const patientRows = await listPatientsWithStatus(null)
  const trials = await listAllTrials()
  const trialNameById = new Map(trials.map((t) => [t.id, t.name]))

  // Bounded fan-out: each row runs several queries, and an unbounded
  // Promise.all over every patient could hold every pool connection at once
  // (see src/lib/concurrency.ts). Row order is unchanged.
  const exportRows: ExportablePatient[] = await mapWithConcurrency(patientRows, WORKBOOK_EXPORT_CONCURRENCY,
    async (p): Promise<ExportablePatient> => {
      const detail = await getPatientDetail(p.id)

      // Latest form submission (by send date) stands in for the patient's
      // current intake-form status; a nurse verifying a patient only cares
      // about where things stand now, not the full submission history.
      const [latestSubmission] = await getDb()
        .select()
        .from(formSubmissions)
        .where(eq(formSubmissions.patientId, p.id))
        .orderBy(desc(formSubmissions.sentDate))
        .limit(1)

      return {
        id: p.id,
        name: p.name,
        dob: p.dob,
        phone: p.phone,
        email: p.email,
        identityVerified: detail?.identityVerification?.verified ?? false,
        idType: detail?.identityVerification?.idType ?? null,
        currentProvider: p.currentProvider,
        referralType: p.referralType,
        diagnoses: (detail?.diagnoses ?? []).map((d) => ({ code: d.code, description: d.description })),
        medications: (detail?.medications ?? []).map((m) => ({ name: m.name, dose: m.dose, startDate: m.startDate })),
        allergies: (detail?.allergies ?? []).map((a) => ({ allergen: a.allergen, severity: a.severity })),
        trialName: p.trialId ? (trialNameById.get(p.trialId) ?? null) : null,
        overallStatus: p.overallStatus ?? null,
        // Only the criteria a nurse still needs to confirm on the call --
        // anything already 'green' is settled and would just be noise here.
        criteriaNeedingVerification: (detail?.criteria ?? [])
          .filter((c) => c.verdict !== 'green')
          .map((c) => ({ criterionText: c.criterionText, evidenceQuote: c.evidenceQuote })),
        formStatus: latestSubmission?.status ?? null,
        lastCommunication: p.lastCommunication,
      }
    })

  const buffer = await buildWorkbookXlsx(exportRows)
  await logAudit(session, 'exported workbook to Excel', null)

  // exceljs's .d.ts declares an ambient global `Buffer extends ArrayBuffer`
  // that conflicts with (and shadows parts of) Node's own `Buffer` type
  // project-wide, which otherwise makes `NextResponse`'s `BodyInit` overload
  // resolution fail here even though a `Buffer` is a perfectly valid body.
  // Passing a plain `Uint8Array` (a type ExcelJS doesn't touch) sidesteps it.
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="ipmg-screening-workbook.xlsx"',
    },
  })
}
