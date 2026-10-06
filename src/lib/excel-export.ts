import ExcelJS from 'exceljs'
import type { WorkbookRow } from '@/lib/queries/workbook'

const COLUMNS = [
  'Anonymous Number',
  'Name', 'DOB', 'Phone', 'Email',
  'Identity Verified', 'ID Type',
  'Current Provider', 'Referral Type',
  'Diagnoses', 'Current Medications', 'Allergies',
  'Trial', 'Overall Status', 'Items Needing Verification',
  'Intake Form Status', 'Last Communication',
]

// How many patients GET /api/workbook/export loads at once. Each row runs
// its queries one after another, so a row holds at most one of the pool's 10
// connections at a time: 8 keeps two free for every other request. Measured
// against Neon on 66 rows with a cold cache: 4 took ~51s, 8 ~27s.
export const WORKBOOK_EXPORT_CONCURRENCY = 8

export interface ExportablePatient {
  id: string
  name: string
  dob: string
  phone: string | null
  email: string | null
  identityVerified: boolean
  idType: string | null
  currentProvider: string | null
  referralType: string | null
  diagnoses: { code: string; description: string }[]
  medications: { name: string; dose: string | null; startDate: string }[]
  allergies: { allergen: string; severity: string }[]
  trialName: string | null
  overallStatus: string | null
  criteriaNeedingVerification: { criterionText: string; evidenceQuote: string | null }[]
  formStatus: string | null
  lastCommunication: string | null
}

// Prevents CSV/Excel formula injection: a value starting with =, +, -, @, tab,
// or CR would be interpreted as a formula by Excel/Sheets when the file is
// opened, letting attacker-controlled data (ultimately sourced from IntakeQ
// form submissions in production) execute as a formula on a staff member's
// machine. Prefixing with an apostrophe forces Excel to treat it as literal
// text, matching the standard mitigation for this vulnerability class.
function sanitizeCell(value: string | null): string | null {
  if (value == null) return value
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

export async function buildWorkbookXlsx(patients: ExportablePatient[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Screening Workbook')
  sheet.addRow(COLUMNS)

  for (const p of patients) {
    const diagnosesStr = p.diagnoses.map((d) => `${d.code}: ${d.description}`).join('; ')
    const medsStr = p.medications.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ''} (since ${m.startDate})`).join('; ')
    const allergiesStr = p.allergies.map((a) => `${a.allergen} (${a.severity})`).join('; ')
    const needsVerificationStr = p.criteriaNeedingVerification.map((c) => `${c.criterionText}${c.evidenceQuote ? ` — "${c.evidenceQuote}"` : ''}`).join(' | ')

    sheet.addRow([
      p.id,
      sanitizeCell(p.name), sanitizeCell(p.dob), sanitizeCell(p.phone), sanitizeCell(p.email),
      p.identityVerified ? 'Yes' : 'No', sanitizeCell(p.idType),
      sanitizeCell(p.currentProvider), sanitizeCell(p.referralType),
      sanitizeCell(diagnosesStr), sanitizeCell(medsStr), sanitizeCell(allergiesStr),
      sanitizeCell(p.trialName), sanitizeCell(p.overallStatus), sanitizeCell(needsVerificationStr),
      sanitizeCell(p.formStatus), sanitizeCell(p.lastCommunication),
    ])
  }

  // exceljs's own .d.ts declares an ambient global `Buffer extends ArrayBuffer`
  // that conflicts with Node's `Buffer`, so `writeBuffer()`'s declared return
  // type is not directly assignable to Node's `Buffer` (used below as the
  // route handler's response body). Route the value through `Buffer.from`
  // (valid since exceljs's type does extend `ArrayBuffer`) to get a real,
  // correctly-typed Node `Buffer` back out.
  const raw = await workbook.xlsx.writeBuffer()
  return Buffer.from(raw as unknown as ArrayBuffer)
}

// The literal 30 headings of the source IPMG pre-screening workbook, in
// their original order -- this list, and the row-building order below, must
// stay in lockstep with WorkbookRow's field order (src/lib/queries/workbook.ts)
// so the in-app grid and this download always show the same columns the same way.
// Originally 30 headings; 'Link Tebra' was dropped (down to 29) once the
// unified-patient-record migration removed patients.tebraChartUrl outright
// (not unified into a single-sourced column like name/dob/phone/etc. -- see
// Task 1 of that plan, which killed it as a cross-system reference with no
// replacement) -- there is no longer any data to put in that column.
const FULL_WORKBOOK_COLUMNS = [
  'Anonymous Number', 'Date Added to Tab', 'Patient Name', 'Current Provider', 'Rating Scales',
  'DOB', 'Age', 'City', 'Zip', 'Phone',
  'Dx Codes', 'Last Communication', 'Referral Type', 'Availability', 'Past & Future Appt Date',
  'Comm Consent Signed/Pref/Intake', 'Form Notes', 'Reviewer Notes', 'Clinician Reviewer Notes', 'PI Recommendation',
  'Active Meds', 'Inactive Meds', 'Old Notes', 'Old Recs',
  'Intake Email', 'Patient Email', 'Meds List from Pharmacy (Outside Confirmation)', 'Template Word Doc in SharePoint', 'Research Depression Prescreening Sent Date',
]

export async function buildFullWorkbookXlsx(rows: WorkbookRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Pre-Screening Workbook')
  sheet.addRow(FULL_WORKBOOK_COLUMNS)

  for (const r of rows) {
    sheet.addRow([
      r.id, r.dateAdded, sanitizeCell(r.patientName), sanitizeCell(r.currentProvider), sanitizeCell(r.ratingScales),
      r.dob, r.age, sanitizeCell(r.city), sanitizeCell(r.zip), sanitizeCell(r.phone),
      sanitizeCell(r.dxCodes), sanitizeCell(r.lastCommunication), sanitizeCell(r.referralType), sanitizeCell(r.availability), sanitizeCell(r.apptDates),
      sanitizeCell(r.commConsent), sanitizeCell(r.formNotes), sanitizeCell(r.reviewerNotes), sanitizeCell(r.clinicianReviewerNotes), sanitizeCell(r.piRecommendation),
      sanitizeCell(r.activeMeds), sanitizeCell(r.inactiveMeds), sanitizeCell(r.oldNotes), sanitizeCell(r.oldRecs),
      sanitizeCell(r.intakeqEmail), sanitizeCell(r.patientEmail), sanitizeCell(r.outsideMedsConfirmation), sanitizeCell(r.templateDocUrl), sanitizeCell(r.prescreeningSentDate),
    ])
  }

  const raw = await workbook.xlsx.writeBuffer()
  return Buffer.from(raw as unknown as ArrayBuffer)
}
