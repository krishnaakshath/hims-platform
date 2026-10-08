import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, sep } from 'node:path'

// Static no-leak guard for Aadhaar (spec §3, plan ruling 1). No DB: this reads
// the source tree. Aadhaar lives only in `patient_aadhaar`; these tests pin
// WHO may touch that table, the ciphertext column and the crypto helpers, so a
// new reader (export, FHIR, search, portal, audit page, a new route) fails
// here until someone reviews it and extends an allowlist on purpose.

const ROOT = join(__dirname, '..', '..')

function walk(p: string): string[] {
  const abs = join(ROOT, p)
  if (!existsSync(abs)) throw new Error(`no such path: ${p}`)
  if (statSync(abs).isFile()) return /\.(ts|tsx)$/.test(abs) ? [p] : []
  const out: string[] = []
  for (const entry of readdirSync(abs)) out.push(...walk(`${p}/${entry}`))
  return out
}
const toPosix = (p: string) => p.split(sep).join('/')
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8')
const SRC = walk('src').map(toPosix)
const filesMatching = (re: RegExp) => SRC.filter((f) => re.test(read(f))).sort()

// Export / interop / search / audit-viewing paths: not a single mention.
const EXPORT_PATHS = [
  // SP7: claim snapshots, both claim copies and the submission writer (ruling 9).
  'src/lib/rcm/snapshot.ts',
  'src/lib/rcm/claim-pdf.ts',
  'src/lib/queries/claim-submissions.ts',
  'src/app/api/rcm/claims',
  'src/lib/queries/rcm-reports.ts',
  'src/lib/rcm/csv.ts',
  'src/app/api/rcm/reports',
  // SP4: invoices, their snapshot and the print views carry only id, name, UHID and postal address.
  'src/lib/billing',
  'src/lib/queries/invoices.ts',
  'src/app/print',
  'src/app/(dashboard)/billing/invoices',
  'src/lib/fhir',
  'src/lib/excel-export.ts',
  'src/app/api/workbook',
  'src/app/api/patients/[anonId]/fhir',
  'src/app/api/patients/[anonId]/ccda',
  'src/app/api/search',
  'src/lib/queries/search.ts',
  'src/lib/queries/workbook.ts',
  'src/app/api/audit-log',
  'src/app/(dashboard)/audit-log',
  'src/lib/queries/audit-log.ts',
  'src/app/api/patient-portal/medications-export',
  // SP6: coder-facing modules and routes
  'src/lib/coding',
  'src/app/api/coding',
  'src/lib/queries/coding.ts',
  'src/lib/queries/coding-workspace.ts',
  'src/lib/queries/coding-queries.ts',
  'src/lib/queries/coding-worklist.ts',
  'src/lib/queries/service-procedure-codes.ts',
  // end SP6
]

describe('no Aadhaar leak (static)', () => {
  it.each(EXPORT_PATHS)('%s never references Aadhaar', (p) => {
    const files = walk(p)
    expect(files.length, p).toBeGreaterThan(0)
    for (const f of files) expect(read(f), f).not.toMatch(/aadhaar/i)
  })

  it('no source file selects aadhaarEncrypted outside the identity writer and its tests', () => {
    expect(filesMatching(/aadhaarEncrypted/)).toEqual(['src/db/schema.ts', 'src/lib/patient-identity.ts'])
  })

  it('the aadhaar_encrypted column name appears only in the schema', () => {
    expect(filesMatching(/aadhaar_encrypted/i)).toEqual(['src/db/schema.ts'])
  })

  it('no raw SQL reads or writes patient_aadhaar', () => {
    expect(filesMatching(/\b(from|join|into|update|table)\s+"?patient_aadhaar\b/i)).toEqual([])
  })

  it('only the reviewed modules reference the patientAadhaar table', () => {
    expect(filesMatching(/\bpatientAadhaar\b/)).toEqual([
      'src/db/schema.ts',
      'src/db/seed.ts', // delete-all on reseed only
      'src/lib/patient-identity.ts', // types only
      'src/lib/queries/patient-profile.ts', // summary-column select + upsert
      'src/lib/queries/patient-registration.ts', // insert in the registration tx
      'src/lib/queries/patients.ts', // getPatientDetail summary-column select + deletePatient
    ])
  })

  it('every read of patientAadhaar is an explicit projection (no whole row, no join, no returning)', () => {
    for (const f of filesMatching(/\bpatientAadhaar\b/)) {
      const src = read(f)
      expect(src, f).not.toMatch(/select\(\s*\)\s*\.from\(\s*patientAadhaar\b/)
      expect(src, f).not.toMatch(/[Jj]oin\(\s*patientAadhaar\b/)
      expect(src, f).not.toMatch(/:\s*patientAadhaar\s*[,}]/) // { a: patientAadhaar } = whole-table projection
      expect(src, f).not.toMatch(/query\.patientAadhaar\b/)
      expect(src, f).not.toMatch(/(insert|update)\(\s*patientAadhaar\b[^;]*?\.returning\(/)
      // Each `.from(patientAadhaar)` closes a `.select({ ... })` that names no ciphertext.
      for (const m of src.matchAll(/\.from\(\s*patientAadhaar\b/g)) {
        const before = src.slice(0, m.index)
        const selectAt = before.lastIndexOf('.select(')
        expect(selectAt, `${f}: from(patientAadhaar) without select`).toBeGreaterThanOrEqual(0)
        const projection = before.slice(selectAt)
        expect(projection.startsWith('.select({'), `${f}: ${projection.slice(0, 40)}`).toBe(true)
        expect(projection, f).not.toMatch(/aadhaarEncrypted|declineNote/)
      }
    }
  })

  it('only the reviewed modules import the crypto helpers', () => {
    expect(filesMatching(/from ['"](@\/lib|\.\.\/lib|\.)\/crypto['"]/)).toEqual([
      'src/app/api/login/mfa/route.ts',
      'src/app/api/login/route.ts',
      'src/app/api/patient-portal/account/mfa/confirm/route.ts',
      'src/app/api/patient-portal/account/mfa/enroll/route.ts',
      'src/app/api/patient-portal/login/mfa/route.ts',
      'src/app/api/patients/[anonId]/identity/route.ts', // KYC document (never Aadhaar)
      'src/db/seed.ts', // KYC fixtures
      'src/lib/integrations/payload-vault.ts', // SP8: encryptWithKey/decryptWithKey under INTEGRATION_PAYLOAD_KEY (never Aadhaar)
      'src/lib/patient-identity.ts', // the one Aadhaar encryptor
      'src/lib/queries/patient-registration.ts', // KYC document (never Aadhaar)
    ])
  })

  it('nothing decrypts Aadhaar: no module that can decrypt mentions it, and only patient-identity encrypts it', () => {
    for (const f of filesMatching(/\bdecryptSensitive\b/)) {
      if (f === 'src/lib/crypto.ts') continue
      expect(read(f), f).not.toMatch(/aadhaar/i)
    }
    expect(read('src/lib/patient-identity.ts')).not.toMatch(/decryptSensitive/)
    expect(filesMatching(/encryptSensitive\([^)]*aadhaar/i)).toEqual([])
    expect(filesMatching(/encryptSensitive\(\s*number\s*\)/)).toEqual(['src/lib/patient-identity.ts'])
  })

  it('getPatientDetail consumers are the reviewed set, and read .aadhaar only through toAadhaarView', () => {
    const consumers = filesMatching(/\bgetPatientDetail\b/).filter((f) => f !== 'src/lib/queries/patients.ts')
    expect(consumers).toEqual([
      'src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx',
      'src/app/(dashboard)/patients/[anonId]/page.tsx',
      'src/app/api/patients/[anonId]/insurance-card/route.ts', // comment only
      'src/app/api/patients/[anonId]/prescriptions/route.ts', // comment only
      'src/app/api/patients/[anonId]/route.ts',
      'src/app/api/workbook/export/route.ts', // named fields only, see EXPORT_PATHS
      'src/components/ConfirmEligibilityButton.tsx', // comment only
      'src/components/DiscrepancyList.tsx', // comment only
      'src/lib/fhir/gather.ts', // comment only
      'src/lib/queries/trial-screenings.ts', // comment only
    ])
    for (const f of consumers) {
      const src = read(f)
      const accesses = src.match(/\.aadhaar\b/g)?.length ?? 0
      const viaView = src.match(/toAadhaarView\(\s*[\w.?]+\.aadhaar\s*,/g)?.length ?? 0
      expect(accesses, f).toBe(viaView)
    }
  })

  it('the patient portal sees only the status', () => {
    const portal = [...walk('src/app/patient-portal'), ...walk('src/app/api/patient-portal'), 'src/lib/queries/patient-portal.ts']
    for (const f of portal) {
      const tokens = read(f).match(/\w*aadhaar\w*/gi) ?? []
      for (const t of tokens) expect(['aadhaarStatus', 'getAadhaarStatus', 'Aadhaar'], `${f}: ${t}`).toContain(t)
    }
  })

  it('no route puts aadhaar in a URL or search param', () => {
    for (const f of walk('src/app')) {
      const src = read(f)
      expect(src, f).not.toMatch(/searchParams\.(get|getAll|has)\(\s*['"`]aadhaar/i)
      expect(src, f).not.toMatch(/[?&]aadhaar\w*=/i)
      expect(toPosix(f), f).not.toMatch(/\[aadhaar/i)
    }
  })
})
