import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup } from '@testing-library/react'
import type { Role } from '@/lib/auth'

// Task 2 (RBAC hardening): the patient directory pages render a reduced,
// non-clinical view for front desk (ruling 2), stay full for the clinical
// roles, never load data for pharmacy/billing/labs, and the chart page
// sends labs to its worklist (ruling 3). All query modules are mocked -- no
// DB or Redis access from this file.

afterEach(() => cleanup())

const LIST_ROW = {
  id: 'RD-T1',
  name: 'Pat Frontdesk',
  dob: '1980-02-03',
  currentProvider: 'Dr. Test',
  referralType: 'Self',
  lastCommunication: null,
  overallStatus: 'red' as const,
  criteriaSummary: { inclusionMet: 2, inclusionTotal: 3, exclusionMet: 1, exclusionTotal: 1 },
}

const DETAIL = {
  id: 'RD-T1',
  name: 'Pat Frontdesk',
  dob: '1980-02-03',
  diagnoses: [{ code: 'F90.0' }],
  medications: [],
  allergies: [],
  criteria: [{
    id: 1,
    criterionText: 'Age 18-65',
    criterionType: 'inclusion' as const,
    verdict: 'green' as const,
    evidenceQuote: 'EVIDENCE-SECRET',
    evidenceSourceDoc: null,
    evidenceSourceDate: null,
  }],
  identityVerification: null,
  discrepancies: [{
    id: 7,
    questionLabel: 'DISCREPANCY-QUESTION',
    patientAnswer: 'No',
    chartFinding: 'Yes',
    resolved: false,
    resolvedBy: null,
    createdAt: new Date('2026-01-01'),
  }],
  overallStatus: 'green' as const,
  selectionConfirmedAt: null,
  chartDataAsOf: new Date('2026-01-01'),
  currentProvider: 'Dr. Test',
  mfaEnabled: false,
  portalConfigured: false,
  contacts: [],
  aadhaar: { status: 'not_recorded', last4: null, declineReason: null, consentRecordedAt: null, recordedByName: null },
}

const DISCHARGED_ADMISSION = {
  id: 11,
  patientId: 'RD-T1',
  status: 'discharged' as const,
  admissionType: 'elective',
  admittedAt: new Date('2026-01-01'),
  dischargedAt: new Date('2026-01-05'),
  dischargeDiagnosis: 'DX-SECRET',
  dischargeDrugs: 'DRUGS-SECRET',
  dischargeDevices: 'DEVICES-SECRET',
  dischargeDiet: 'DIET-SECRET',
  dischargeSummaryNotes: 'NOTES-SECRET',
  transfers: [],
  dischargeSignature: null,
}

function mockCommon(role: Role) {
  const spies = {
    redirect: vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT:${to}`) }),
    listPatientsWithStatus: vi.fn(async () => [
      { ...LIST_ROW, trialId: 'trial-a' },
      { ...LIST_ROW, trialId: 'trial-b' },
    ]),
    getPatientDetail: vi.fn(async () => DETAIL),
    listAllTrials: vi.fn(async () => [{ id: 'trial-a', condition: 'TRIAL-A-CONDITION' }, { id: 'trial-b', condition: 'TRIAL-B-CONDITION' }]),
    listAdmissionsForPatient: vi.fn(async () => [DISCHARGED_ADMISSION]),
    listAvailableRooms: vi.fn(async () => []),
    getDb: vi.fn(() => { throw new Error('DB_BLOCKED') }),
  }
  vi.resetModules()
  vi.doMock('next/navigation', () => ({
    redirect: spies.redirect,
    notFound: () => { throw new Error('NEXT_NOT_FOUND') },
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: `Test ${role}`, userId: null })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/db/client', () => ({ getDb: spies.getDb }))
  vi.doMock('@/lib/queries/patients', () => ({ listPatientsWithStatus: spies.listPatientsWithStatus, getPatientDetail: spies.getPatientDetail }))
  vi.doMock('@/lib/queries/trials', () => ({ listAllTrials: spies.listAllTrials }))
  vi.doMock('@/lib/queries/admissions', () => ({ listAdmissionsForPatient: spies.listAdmissionsForPatient }))
  vi.doMock('@/lib/queries/rooms', () => ({ listAvailableRooms: spies.listAvailableRooms }))
  vi.doMock('@/lib/queries/follow-ups', () => ({ listFollowUpsForPatient: async () => [] }))
  vi.doMock('@/lib/queries/encounters', () => ({ listEncountersForPatient: async () => [] }))
  vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: async () => [] }))
  vi.doMock('@/lib/queries/departments', () => ({ listDepartments: async () => [] }))
  // SP7: the Insurance tab's loaders
  vi.doMock('@/lib/queries/rcm-policies', () => ({ listPatientPolicies: async () => [], legacyPolicyPrefill: async () => null }))
  vi.doMock('@/lib/queries/rcm-payers', () => ({ listRcmPayers: async () => [] }))
  return spies
}

async function renderList(role: Role) {
  const spies = mockCommon(role)
  const { default: PatientsPage } = await import('@/app/(dashboard)/patients/page')
  const { render, screen } = await import('@testing-library/react')
  render(await PatientsPage({ searchParams: Promise.resolve({ trialId: 'trial-a' }) }))
  return { spies, screen }
}

async function renderDetail(role: Role) {
  const spies = mockCommon(role)
  const { default: PatientDetailPage } = await import('@/app/(dashboard)/patients/[anonId]/page')
  const { render, screen } = await import('@testing-library/react')
  render(await PatientDetailPage({ params: Promise.resolve({ anonId: 'RD-T1' }) }))
  return { spies, screen }
}

describe('/patients list', () => {
  it('frontdesk sees each patient once with no verdict or criteria text', async () => {
    const { spies, screen } = await renderList('frontdesk')
    expect(screen.getAllByText('Pat Frontdesk')).toHaveLength(1)
    expect(screen.queryByText('Potential Exclusion')).not.toBeInTheDocument()
    expect(screen.queryByText('Meets')).not.toBeInTheDocument()
    expect(screen.queryByText('Needs Verification')).not.toBeInTheDocument()
    expect(screen.queryByText(/inclusion/)).not.toBeInTheDocument()
    expect(screen.queryByText(/exclusion/)).not.toBeInTheDocument()
    expect(screen.queryByText(/No screening evidence/)).not.toBeInTheDocument()
    // No trial tab bar, and the trialId filter is ignored (whole directory).
    expect(screen.queryByText('All Trials')).not.toBeInTheDocument()
    expect(screen.queryByText('TRIAL-A-CONDITION')).not.toBeInTheDocument()
    expect(spies.listAllTrials).not.toHaveBeenCalled()
    expect(spies.listPatientsWithStatus).toHaveBeenCalledWith(null)
    // No chart link for frontdesk.
    expect(screen.queryByText('Medical Record')).not.toBeInTheDocument()
  })

  it('frontdesk keeps the Add Patient button', async () => {
    const { screen } = await renderList('frontdesk')
    expect(screen.getByRole('button', { name: 'Add New Patient' })).toBeInTheDocument()
  })

  it('admin still sees verdicts, criteria counts, the trial filter and the chart link', async () => {
    const { spies, screen } = await renderList('admin')
    expect(screen.getAllByText('Potential Exclusion').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/inclusion/).length).toBeGreaterThan(0)
    expect(screen.getByText('All Trials')).toBeInTheDocument()
    expect(screen.getByText('TRIAL-A-CONDITION')).toBeInTheDocument()
    expect(screen.getAllByText('Medical Record').length).toBeGreaterThan(0)
    expect(spies.listPatientsWithStatus).toHaveBeenCalledWith('trial-a')
  })

  it.each(['crc', 'pi'] as const)('%s still sees verdicts and the chart link', async (role) => {
    const { screen } = await renderList(role)
    expect(screen.getAllByText('Potential Exclusion').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Medical Record').length).toBeGreaterThan(0)
  })
})

// Pins the SERVER-SIDE projection: PatientsTable is a client component, so
// whatever the page passes it is serialized into the RSC payload even when
// showScreening={false} hides it. Capture the props instead of reading text.
type TableProps = { patients: Record<string, unknown>[]; showScreening?: boolean; showMedicalRecordLink?: boolean }
async function captureListProps(role: Role): Promise<TableProps> {
  const spies = mockCommon(role)
  const captured: TableProps[] = []
  vi.doMock('@/components/PatientsTable', () => ({
    PatientsTable: (props: TableProps) => { captured.push(props); return null },
  }))
  const { default: PatientsPage } = await import('@/app/(dashboard)/patients/page')
  const { render } = await import('@testing-library/react')
  render(await PatientsPage({ searchParams: Promise.resolve({}) }))
  expect(spies.listPatientsWithStatus).toHaveBeenCalled()
  expect(captured.length).toBeGreaterThan(0)
  return captured[captured.length - 1]
}

// Wave B P1-08: server-side filter (name / UHID / mobile / id) and pagination.
describe('/patients list -- server filter and pagination', () => {
  async function propsFor(role: Role, sp: Record<string, string>, rows: Record<string, unknown>[]) {
    const spies = mockCommon(role)
    spies.listPatientsWithStatus.mockResolvedValue(rows as never)
    const captured: (TableProps & { directory?: Record<string, unknown> })[] = []
    vi.doMock('@/components/PatientsTable', () => ({ PatientsTable: (props: TableProps) => { captured.push(props); return null } }))
    const { default: PatientsPage } = await import('@/app/(dashboard)/patients/page')
    const { render } = await import('@testing-library/react')
    render(await PatientsPage({ searchParams: Promise.resolve(sp) }))
    return captured[captured.length - 1]
  }
  const many = Array.from({ length: 45 }, (_, i) => ({ ...LIST_ROW, id: `RD-${String(i).padStart(4, '0')}`, name: `Patient ${i}`, uhid: `UH${String(i).padStart(6, '0')}`, phone: i === 7 ? '+919812300077' : null }))

  it('sends one page of rows with UHID and mobile, and the total', async () => {
    const props = await propsFor('frontdesk', { page: '2' }, many)
    expect(props.patients).toHaveLength(15)
    expect(props.patients[0]).toMatchObject({ id: 'RD-0030', uhid: 'UH000030', phone: null })
    expect(props.directory).toMatchObject({ page: 2, pageSize: 30, total: 45, query: '' })
  })

  it('filters by mobile on the server before paging', async () => {
    const props = await propsFor('admin', { q: '98123 00077' }, many)
    expect(props.patients.map((p) => p.id)).toEqual(['RD-0007'])
    expect(props.directory).toMatchObject({ total: 1, query: '98123 00077' })
  })

  it('filters by UHID and keeps the trial filter in the paging params for clinical roles', async () => {
    const props = await propsFor('crc', { q: 'uh000044', trialId: 'trial-a' }, many)
    expect(props.patients.map((p) => p.id)).toEqual(['RD-0044'])
    expect(props.directory).toMatchObject({ params: { trialId: 'trial-a' } })
  })
})

describe('/patients list -- props sent to the client', () => {
  it('frontdesk rows carry no overallStatus or criteriaSummary key, and screening/chart link are off', async () => {
    const props = await captureListProps('frontdesk')
    expect(props.patients.length).toBeGreaterThan(0)
    for (const row of props.patients) {
      expect(row).not.toHaveProperty('overallStatus')
      expect(row).not.toHaveProperty('criteriaSummary')
    }
    expect(props.showScreening).toBe(false)
    expect(props.showMedicalRecordLink).toBe(false)
  })

  it.each(['admin', 'crc', 'pi'] as const)('%s rows still carry overallStatus and criteriaSummary', async (role) => {
    const props = await captureListProps(role)
    expect(props.patients.length).toBeGreaterThan(0)
    for (const row of props.patients) {
      expect(row).toHaveProperty('overallStatus', 'red')
      expect(row).toHaveProperty('criteriaSummary', LIST_ROW.criteriaSummary)
    }
    expect(props.showScreening).toBe(true)
    expect(props.showMedicalRecordLink).toBe(true)
  })
})

describe('/patients/[anonId] detail', () => {
  it('frontdesk sees no screening, discrepancies, quick glance or discharge clinical text', async () => {
    const { screen } = await renderDetail('frontdesk')
    expect(screen.getByText('Pat Frontdesk')).toBeInTheDocument()
    expect(screen.getByText('Identity Verification')).toBeInTheDocument()
    expect(screen.getByText('Patient Portal Access')).toBeInTheDocument()
    expect(screen.getByText('Inpatient History')).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: 'Screening' })).not.toBeInTheDocument()
    expect(screen.queryByText('Screening Evidence')).not.toBeInTheDocument()
    expect(screen.queryByText('EVIDENCE-SECRET')).not.toBeInTheDocument()
    expect(screen.queryByText('Form vs. Chart Discrepancies')).not.toBeInTheDocument()
    expect(screen.queryByText('DISCREPANCY-QUESTION')).not.toBeInTheDocument()
    expect(screen.queryByText('Criteria evaluated')).not.toBeInTheDocument()
    expect(screen.queryByText('Meets')).not.toBeInTheDocument()
    expect(screen.queryByText('Needs Verification')).not.toBeInTheDocument()
    expect(screen.queryByText(/Medical Record/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Diagnoses/)).not.toBeInTheDocument()
    for (const secret of ['DX-SECRET', 'DRUGS-SECRET', 'DEVICES-SECRET', 'DIET-SECRET', 'NOTES-SECRET']) {
      expect(screen.queryByText(new RegExp(secret)), secret).not.toBeInTheDocument()
    }
    // No blank discharge labels either (the fields are nulled server-side).
    for (const label of ['Diagnosis:', 'Drugs:', 'Devices:', 'Diet:', 'Notes:']) {
      expect(screen.queryByText(label), label).not.toBeInTheDocument()
    }
    expect(screen.getByText(/Discharged/)).toBeInTheDocument()
  })

  it.each(['admin', 'crc', 'pi'] as const)('%s keeps the full clinical view', async (role) => {
    const { screen } = await renderDetail(role)
    expect(screen.getByRole('button', { name: 'Screening' })).toBeInTheDocument()
    expect(screen.getByText('EVIDENCE-SECRET')).toBeInTheDocument()
    expect(screen.getByText('Form vs. Chart Discrepancies')).toBeInTheDocument()
    expect(screen.getByText('Criteria evaluated')).toBeInTheDocument()
    expect(screen.getByText(/DX-SECRET/)).toBeInTheDocument()
    expect(screen.getByText('View Full Medical Record')).toBeInTheDocument()
    for (const label of ['Diagnosis:', 'Drugs:', 'Devices:', 'Diet:', 'Notes:']) {
      expect(screen.getByText(label), label).toBeInTheDocument()
    }
  })

  it.each(['admin', 'frontdesk'] as const)('%s sees no Refresh from Source Systems or Dual-sourced copy', async (role) => {
    const { screen } = await renderDetail(role)
    expect(screen.queryByText(/Refresh from Source Systems/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Dual-sourced/)).not.toBeInTheDocument()
  })
})

describe('roles without the patient directory never load patient data', () => {
  it.each(['pharmacy', 'billing', 'labs', 'coder', 'collector', 'rcm'] as const)('%s is redirected from /patients before any query', async (role) => {
    const spies = mockCommon(role)
    const { default: PatientsPage } = await import('@/app/(dashboard)/patients/page')
    await expect(PatientsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT:/')
    expect(spies.redirect).toHaveBeenCalledWith('/')
    expect(spies.listPatientsWithStatus).not.toHaveBeenCalled()
    expect(spies.listAllTrials).not.toHaveBeenCalled()
    expect(spies.getDb).not.toHaveBeenCalled()
  })

  it.each(['pharmacy', 'billing', 'labs', 'coder', 'collector', 'rcm'] as const)('%s is redirected from /patients/[anonId] before any query', async (role) => {
    const spies = mockCommon(role)
    const { default: PatientDetailPage } = await import('@/app/(dashboard)/patients/[anonId]/page')
    await expect(PatientDetailPage({ params: Promise.resolve({ anonId: 'RD-T1' }) })).rejects.toThrow('NEXT_REDIRECT:/')
    expect(spies.getPatientDetail).not.toHaveBeenCalled()
    expect(spies.listAdmissionsForPatient).not.toHaveBeenCalled()
    expect(spies.getDb).not.toHaveBeenCalled()
  })
})

describe('/patients/[anonId]/medical-record', () => {
  it('sends labs to its worklist without loading the chart', async () => {
    const spies = mockCommon('labs')
    const { default: MedicalRecordPage } = await import('@/app/(dashboard)/patients/[anonId]/medical-record/page')
    await expect(MedicalRecordPage({ params: Promise.resolve({ anonId: 'RD-T1' }) })).rejects.toThrow('NEXT_REDIRECT:/labs')
    expect(spies.getPatientDetail).not.toHaveBeenCalled()
    expect(spies.getDb).not.toHaveBeenCalled()
  })

  it.each(['frontdesk', 'pharmacy', 'billing', 'collector'] as const)('redirects %s to / without loading the chart', async (role) => {
    const spies = mockCommon(role)
    const { default: MedicalRecordPage } = await import('@/app/(dashboard)/patients/[anonId]/medical-record/page')
    await expect(MedicalRecordPage({ params: Promise.resolve({ anonId: 'RD-T1' }) })).rejects.toThrow('NEXT_REDIRECT:/')
    expect(spies.redirect).toHaveBeenCalledWith('/')
    expect(spies.getPatientDetail).not.toHaveBeenCalled()
    expect(spies.getDb).not.toHaveBeenCalled()
  })
})

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.(t|j)sx?$/.test(e.name) ? [p] : []
  })
}

describe('stale refresh-from-source copy is gone', () => {
  const srcFiles = walk(join(process.cwd(), 'src'))

  it('RefreshEligibilityButton is deleted with no remaining caller', () => {
    expect(existsSync(join(process.cwd(), 'src', 'components', 'RefreshEligibilityButton.tsx'))).toBe(false)
    expect(srcFiles.filter((f) => readFileSync(f, 'utf8').includes('RefreshEligibilityButton'))).toEqual([])
  })

  // Case-sensitive on purpose: this pins the user-facing copy. A pre-existing
  // code comment in src/db/schema.ts ("Dual-Sourced Fields") is left alone
  // (no schema-file edits in this plan).
  it("no file under src/ says 'Refresh from Source Systems' or 'Dual-sourced'", () => {
    expect(srcFiles.filter((f) => /Refresh from Source Systems|Dual-sourced/.test(readFileSync(f, 'utf8')))).toEqual([])
  })
})
