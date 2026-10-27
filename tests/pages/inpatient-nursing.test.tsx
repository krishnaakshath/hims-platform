// WS3 T7: /inpatient/nursing -- CLINICAL_ROLES; the round's Give/Hold/Refuse follow the administer route (pi/admin).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ROUND = [{
  medicationId: 11, admissionId: 5, patientName: 'Sunita Devi', uhid: 'UH-2026-000042', bedLabel: 'General Ward 101-A',
  medicationName: 'Paracetamol 650 mg', dose: '1 tab', scheduledFor: new Date('2026-10-23T02:30:00Z'), status: 'scheduled' as const, overdue: true,
}]
const ADMITTED = [{ admissionId: 5, patientId: 'RD-0042', patientName: 'Sunita Devi', uhid: 'UH-2026-000042', bedLabel: 'General Ward 101-A', ward: 'General Ward' }]

async function renderAs(role: string) {
  vi.resetModules()
  const redirect = vi.fn(() => { throw new Error('NEXT_REDIRECT') })
  vi.doMock('next/navigation', () => ({ redirect, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Test', userId: null })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  const listMedicationRound = vi.fn(async () => ROUND)
  vi.doMock('@/lib/queries/medication-round', () => ({ listMedicationRound, listAdmittedForNursing: vi.fn(async () => ADMITTED) }))
  const { default: Page } = await import('@/app/(dashboard)/inpatient/nursing/page')
  return { Page, redirect, listMedicationRound }
}

describe('/inpatient/nursing', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('redirects billing to / before loading anything', async () => {
    const { Page, redirect, listMedicationRound } = await renderAs('billing')
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/')
    expect(listMedicationRound).not.toHaveBeenCalled()
  })

  it('renders both tabs for crc, with the UHID and the overdue dose, but no Give/Hold/Refuse', async () => {
    const { Page } = await renderAs('crc')
    const { render, screen } = await import('@testing-library/react')
    render(await Page({ searchParams: Promise.resolve({}) }))
    expect(screen.getByRole('tab', { name: 'Medication round' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Vitals' })).toBeInTheDocument()
    expect(screen.getByText('Paracetamol 650 mg')).toBeInTheDocument()
    expect(screen.getAllByText(/UH-2026-000042/).length).toBeGreaterThan(0)
    expect(screen.queryByText('RD-0042')).not.toBeInTheDocument()
    expect(screen.getByText('Overdue')).toBeInTheDocument()
    expect(screen.getByText('8:00 am IST')).toBeInTheDocument() // the hour group
    expect(screen.getByText('8:00 am')).toBeInTheDocument() // the dose time
    expect(screen.queryByRole('button', { name: /^Give/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Hold/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Refuse/ })).not.toBeInTheDocument()
  })

  it('shows Give/Hold/Refuse for pi', async () => {
    const { Page } = await renderAs('pi')
    const { render, screen } = await import('@testing-library/react')
    render(await Page({ searchParams: Promise.resolve({}) }))
    expect(screen.getByRole('button', { name: /^Give/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Hold/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Refuse/ })).toBeInTheDocument()
  })
})
