import { describe, it, expect, vi, afterEach } from 'vitest'
import type { DischargeSummaryData } from '@/lib/encounters/discharge-summary'

// Wave F P1-13: the printable A4 discharge summary.
class NotFound extends Error {}
class Redirect extends Error {}
const state = vi.hoisted(() => ({
  role: 'pi',
  logAudit: vi.fn(async () => undefined),
  redirect: vi.fn(),
  getData: vi.fn(),
}))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new NotFound() },
  redirect: (to: string) => { state.redirect(to); throw new Redirect(to) },
}))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: state.role, name: 'Dr. Test', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: state.logAudit }))
vi.mock('@/lib/queries/discharge-summary', () => ({ getDischargeSummaryData: state.getData }))
vi.mock('@/lib/queries/settings', () => ({ getPracticeIdentity: vi.fn(async () => ({ practiceName: 'Sunrise Multispeciality Hospital', practiceSite: 'Pune' })) }))

import DischargeSummaryPrintPage from '@/app/print/discharge/[admissionId]/page'

const CLINICAL: DischargeSummaryData = {
  hospitalName: 'HIMS',
  timezone: 'Asia/Kolkata',
  generatedAt: '2026-10-06T04:30:00.000Z',
  patient: {
    id: 'RD-0042', uhid: 'UH-000042', name: 'Asha Rao', ageYears: 46, gender: 'Female', abhaNumber: '91-2345-6789-0123', abhaAddress: 'asha.rao@abdm',
    address: '12 MG Road, Pune, Maharashtra 411001', isMlc: true, mlcNumber: 'MLC-7',
  },
  admission: { id: 55, admissionType: 'emergency', admittedOn: '2026-10-02', dischargedOn: '2026-10-05', lengthOfStayDays: 3, lastWard: 'Ward B' },
  attending: { providerId: 3, name: 'Dr. Meera Iyer', registration: 'SMC IN-MH 12345', departmentName: 'General Medicine' },
  clinical: { diagnosis: 'Community-acquired pneumonia', drugs: 'Amoxicillin 500 mg TDS x 5 days', devices: 'None', diet: 'Soft diet', notes: 'Recovered well on IV antibiotics' },
  followUp: { dueDate: '2026-10-19', windowStart: '2026-10-16', windowEnd: '2026-10-26', reason: 'Chest X-ray review', status: 'scheduled', appointmentStartsAt: '2026-10-19T04:30:00.000Z' },
  signature: { signerTypedName: 'Dr. Meera Iyer', signedAt: '2026-10-05T05:01:00.000Z' },
  record: {
    diagnoses: [
      { code: 'J18.9', system: 'icd10', description: 'Pneumonia, unspecified organism', type: 'primary', codingStatus: 'coded' },
      { code: 'E11.9', system: 'icd10', description: 'Type 2 diabetes mellitus', type: 'secondary', codingStatus: 'proposed' },
      { code: null, system: null, description: 'Mild anaemia', type: 'secondary', codingStatus: 'uncoded' },
    ],
    medications: [{ name: 'Ceftriaxone', dose: '1 g IV', given: 6, firstGivenAt: '2026-10-02T03:00:00.000Z', lastGivenAt: '2026-10-04T15:00:00.000Z' }],
    labs: [{ testName: 'Haemoglobin', testCode: '718-7', value: '10.2', unit: 'g/dL', referenceRange: '12-15', flag: 'abnormal', resultedAt: '2026-10-02T06:00:00.000Z' }],
    labsNotFinal: 1,
  },
}

const FRONT_DESK: DischargeSummaryData = {
  ...CLINICAL,
  patient: { ...CLINICAL.patient, abhaNumber: null, abhaAddress: null, mlcNumber: null },
  clinical: null,
  record: null,
}

function page(id: string) {
  return DischargeSummaryPrintPage({ params: Promise.resolve({ admissionId: id }) })
}

afterEach(() => {
  state.role = 'pi'
  state.logAudit.mockClear()
  state.redirect.mockClear()
  state.getData.mockReset()
})

describe('/print/discharge/[admissionId]', () => {
  it('renders the clinical summary: hospital header, patient, IST dates, ICD codes, stay medicines, labs, discharge plan, follow-up, signature', async () => {
    state.getData.mockResolvedValue(CLINICAL)
    const { render, screen } = await import('@testing-library/react')
    const { container } = render(await page('55'))
    expect(state.getData).toHaveBeenCalledWith(55, expect.objectContaining({ viewerRole: 'pi' }))
    expect(screen.getByRole('heading', { level: 1, name: /discharge summary/i })).toBeInTheDocument()
    expect(screen.getByText('Sunrise Multispeciality Hospital')).toBeInTheDocument()
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.getByText('UH-000042')).toBeInTheDocument()
    expect(screen.getByText('46 y / Female')).toBeInTheDocument()
    expect(screen.getAllByText('2 Oct 2026').length).toBeGreaterThan(0)
    expect(screen.getAllByText('5 Oct 2026').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Reg\. No\. SMC IN-MH 12345/).length).toBe(2)
    expect(screen.getByText('J18.9')).toBeInTheDocument()
    expect(screen.getByText('Pneumonia, unspecified organism')).toBeInTheDocument()
    expect(screen.getByText(/provisional code/i)).toBeInTheDocument()
    expect(screen.getByText('Mild anaemia')).toBeInTheDocument()
    expect(screen.getByText('Ceftriaxone')).toBeInTheDocument()
    expect(screen.getByText('Haemoglobin')).toBeInTheDocument()
    expect(screen.getByText(/1 test ordered during the stay has no verified result/i)).toBeInTheDocument()
    expect(screen.getByText('Amoxicillin 500 mg TDS x 5 days')).toBeInTheDocument()
    expect(screen.getByText('Chest X-ray review')).toBeInTheDocument()
    // 04:30 UTC is 10:00 am IST.
    expect(screen.getByText(/19 Oct 2026, 10:00 am IST/)).toBeInTheDocument()
    expect(screen.getByText(/Signed by Dr\. Meera Iyer on 5 Oct 2026, 10:31 am IST/)).toBeInTheDocument()
    expect(screen.getByText('91-2345-6789-0123')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/aadhaar/i)
    expect(state.logAudit).toHaveBeenCalledWith(expect.anything(), 'printed discharge summary', 'RD-0042', 'admission=55')
  })

  it('an unsigned summary says so on the document', async () => {
    state.getData.mockResolvedValue({ ...CLINICAL, signature: null })
    const { render, screen } = await import('@testing-library/react')
    render(await page('55'))
    expect(screen.getByText(/not yet signed/i)).toBeInTheDocument()
  })

  it('the front desk gets the administrative copy: no clinical sections, no ABHA', async () => {
    state.role = 'frontdesk'
    state.getData.mockResolvedValue(FRONT_DESK)
    const { render, screen } = await import('@testing-library/react')
    const { container } = render(await page('55'))
    expect(state.getData).toHaveBeenCalledWith(55, expect.objectContaining({ viewerRole: 'frontdesk' }))
    expect(screen.getByText(/administrative copy/i)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/pneumonia|Amoxicillin|J18\.9|91-2345/i)
    expect(screen.getByText('Chest X-ray review')).toBeInTheDocument()
  })

  it.each(['abc', '0', '-1', '99999999999'])('a malformed id (%s) is a 404 with no query and no audit row', async (id) => {
    await expect(page(id)).rejects.toThrow(NotFound)
    expect(state.getData).not.toHaveBeenCalled()
    expect(state.logAudit).not.toHaveBeenCalled()
  })

  it('an unknown or not-yet-discharged admission is a 404 with no audit row', async () => {
    state.getData.mockResolvedValue(null)
    await expect(page('77')).rejects.toThrow(NotFound)
    expect(state.logAudit).not.toHaveBeenCalled()
  })

  it.each(['pharmacy', 'billing', 'labs', 'coder', 'collector'])('a %s session is redirected home before any query', async (role) => {
    state.role = role
    await expect(page('55')).rejects.toThrow(Redirect)
    expect(state.redirect).toHaveBeenCalledWith('/')
    expect(state.getData).not.toHaveBeenCalled()
    expect(state.logAudit).not.toHaveBeenCalled()
  })

  it('prints with an explicit click only, controls marked no-print', async () => {
    state.getData.mockResolvedValue(CLINICAL)
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined)
    const { render, screen } = await import('@testing-library/react')
    render(await page('55'))
    expect(printSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /print/i }).closest('.no-print')).not.toBeNull()
    printSpy.mockRestore()
  })
})
