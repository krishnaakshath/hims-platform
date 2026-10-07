import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Wave C front-desk quick path: Check in / Book appointment / Print UHID card
// from the patient page, and the "just registered" banner.
afterEach(() => cleanup())

const DETAIL = {
  id: 'RD-0001', uhid: 'UH-000042', name: 'Asha Rao', dob: '1990-01-01',
  gender: 'female', maritalStatus: null, bloodGroup: null, occupation: null, nationality: 'IN', religion: null, preferredLanguage: null,
  addressLine1: '12 MG Road', addressLine2: null, city: 'Pune', district: 'Pune', stateCode: 'IN-MH', pinCode: '411001',
  phone: null, email: null, abhaNumber: null, abhaAddress: null, abhaUnavailableReason: null, abhaUnavailableNote: null, isMlc: false, mlcNumber: null,
  contacts: [],
  aadhaar: { status: 'not_recorded', last4: null, declineReason: null, consentRecordedAt: null, recordedByName: null },
  diagnoses: [], medications: [], allergies: [], criteria: [], identityVerification: null, discrepancies: [],
  overallStatus: null, selectionConfirmedAt: null, chartDataAsOf: new Date('2026-01-01'), currentProvider: null, mfaEnabled: false, portalConfigured: false,
}

async function renderAs(role: string, searchParams: Record<string, string> = {}) {
  vi.resetModules()
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Tester' })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/lib/queries/rooms', () => ({ listAvailableRooms: vi.fn(async () => []) }))
  vi.doMock('@/lib/queries/follow-ups', () => ({ listFollowUpsForPatient: async () => [] }))
  vi.doMock('@/lib/queries/encounters', () => ({ listEncountersForPatient: async () => [] }))
  vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: async () => [] }))
  vi.doMock('@/lib/queries/departments', () => ({ listDepartments: async () => [] }))
  vi.doMock('@/lib/queries/patients', () => ({ getPatientDetail: vi.fn(async () => DETAIL) }))
  vi.doMock('@/lib/queries/admissions', () => ({ listAdmissionsForPatient: vi.fn(async () => []) }))
  vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), notFound: vi.fn(), redirect: vi.fn() }))
  const { default: Page } = await import('@/app/(dashboard)/patients/[anonId]/page')
  const { render, screen } = await import('@testing-library/react')
  render(await Page({ params: Promise.resolve({ anonId: 'RD-0001' }), searchParams: Promise.resolve(searchParams) }))
  return { screen }
}

describe('Patient detail quick actions', () => {
  it.each([
    ['frontdesk', true, true, true],
    ['admin', true, true, true],
    ['crc', true, true, false],
    ['pi', false, true, false],
  ])('%s: check in %s, book %s, print UHID card %s', async (role, checkIn, book, card) => {
    const { screen } = await renderAs(role)
    const link = (name: RegExp) => screen.queryByRole('link', { name })
    expect(link(/^check in$/i)?.getAttribute('href') ?? null).toBe(checkIn ? '/front-desk/check-in?patient=RD-0001' : null)
    expect(link(/book appointment/i)?.getAttribute('href') ?? null).toBe(book ? '/calendar?book=RD-0001' : null)
    expect(link(/print uhid card/i)?.getAttribute('href') ?? null).toBe(card ? '/print/registration/RD-0001' : null)
  })

  it('shows the registration banner with the slip link after registering', async () => {
    const { screen } = await renderAs('frontdesk', { registered: '1' })
    const banner = screen.getAllByRole('status').find((el) => /patient registered/i.test(el.textContent ?? ''))!
    expect(banner).toHaveTextContent(/registered/i)
    expect(banner).toHaveTextContent('UH-000042')
    expect(screen.getByRole('link', { name: /print registration slip/i })).toHaveAttribute('href', '/print/registration/RD-0001')
  })

  it('shows no banner without ?registered=1, or for a role that cannot register', async () => {
    const a = await renderAs('frontdesk')
    expect(a.screen.queryByText(/patient registered/i)).not.toBeInTheDocument()
    cleanup()
    const b = await renderAs('pi', { registered: '1' })
    expect(b.screen.queryByText(/patient registered/i)).not.toBeInTheDocument()
  })

  // Wave C P1-11: admin-only correction of name / DOB.
  it.each([['admin', true], ['crc', false], ['frontdesk', false], ['pi', false]])('%s sees the name/DOB correction: %s', async (role, shows) => {
    const { screen } = await renderAs(role)
    expect(!!screen.queryByRole('button', { name: /correct name/i })).toBe(shows)
  })
})
