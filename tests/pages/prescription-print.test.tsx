import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('notFound') },
  redirect: (to: string) => { throw new Error(`redirect:${to}`) },
}))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Dr. Test', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/settings', () => ({ getPracticeIdentity: vi.fn(async () => ({ practiceName: 'Clinic', practiceSite: null })) }))
vi.mock('@/lib/queries/print-slips', () => ({
  getPatientDocumentIdentity: vi.fn(async () => ({ id: 'RD-0001', name: 'Test Patient', uhid: 'UH00000042', dob: '1990-01-01', gender: null })),
}))
const row = {
  id: 1, patientId: 'RD-0001', name: 'Amoxil', medicationClass: 'Antibiotic', dose: '500 mg', frequencyPerDay: 2, durationDays: 5,
  instructions: null, prescribedAt: new Date('2026-10-01T05:00:00Z'), enteredByName: 'Dr. Test',
  prescriber: { id: 1, name: 'Dr. Test', credentials: 'MD', specialty: 'Medicine' }, prescriberRegistration: 'NMC 12345',
  genericName: 'Amoxicillin', dosePattern: '1-0-1', route: 'oral', foodTiming: 'after_food', isSos: false, quantityPrescribed: 10, advice: 'Rest and fluids',
}
const printable = vi.fn()
vi.mock('@/lib/queries/prescriptions', () => ({ getPrintablePrescriptions: (...a: unknown[]) => printable(...a) }))

async function html() {
  const { default: Page } = await import('@/app/prescriptions/print/page')
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ ids: '1' }) }))
}

describe('prescription print page (WS1 T7)', () => {
  it('prints pattern line, generic, advice, registration and the UHID (never the chart id as text)', async () => {
    printable.mockResolvedValue([row])
    const out = await html()
    expect(out).toContain('1-0-1 (morning, night) × 5 days, after food')
    expect(out).toContain('Amoxicillin')
    expect(out).toContain('Rest and fluids')
    expect(out).toContain('Reg. No. NMC 12345')
    expect(out).toContain('UH00000042')
    expect(out.replace(/href="[^"]*"/g, '')).not.toContain('RD-0001')
  })

  it('a legacy row (no pattern) still prints', async () => {
    printable.mockResolvedValue([{ ...row, genericName: null, dosePattern: null, route: null, foodTiming: null, quantityPrescribed: null, advice: null }])
    const out = await html()
    expect(out).toContain('2 times daily × 5 days')
    expect(out).not.toContain('Advice')
  })
})
