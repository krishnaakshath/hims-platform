import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, medicationEpisodes } from '@/db/schema'
import { getPatientIdentityForPrint } from '@/lib/queries/patients'
import { brand } from '@/lib/brand'

class NotFound extends Error {}
class Redirect extends Error {}
const mockRedirect = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  notFound: () => { throw new NotFound() },
  redirect: (to: string) => { mockRedirect(to); throw new Redirect(to) },
}))

const state = vi.hoisted(() => ({ sessionRole: 'pi', logAudit: vi.fn(async () => undefined) }))
const sessionName = 'Dr. R. Kunam'

vi.mock('@/lib/auth', () => ({
  requireSessionOrRedirect: vi.fn(async () => ({ role: state.sessionRole, name: sessionName, userId: null })),
}))

vi.mock('@/lib/audit', () => ({ logAudit: state.logAudit }))
const logAudit = state.logAudit

import PrescriptionPrintPage from '@/app/prescriptions/print/page'

let patientA: string
let patientB: string
let patientAName: string
let providerId: number
let providerName: string
let providerCredentials: string | null
let providerSpecialty: string

let episodeA1: number
let episodeA2: number
let episodeB1: number
let episodeAImported: number

beforeAll(async () => {
  const db = getDb()
  const patientRows = await db.select({ id: patients.id }).from(patients).limit(2)
  if (patientRows.length < 2) throw new Error('Need at least two seeded patients for this suite')
  ;[patientA, patientB] = patientRows.map((p) => p.id)

  const identity = await getPatientIdentityForPrint(patientA)
  if (!identity) throw new Error('Could not resolve patient A identity')
  // Trimmed: testing-library's default text matcher normalizes (trims,
  // collapses) the rendered node's text before comparing, but not a raw
  // string passed in as the matcher -- and this seeded row's name carries
  // trailing whitespace on the live DB.
  patientAName = identity.name.trim()

  const [providerRow] = await db.select().from(providers).where(eq(providers.isActive, true)).limit(1)
  if (!providerRow) throw new Error('Need at least one active seeded provider')
  providerId = providerRow.id
  providerName = providerRow.name
  providerCredentials = providerRow.credentials
  providerSpecialty = providerRow.specialty

  const [a1] = await db.insert(medicationEpisodes).values({
    patientId: patientA, name: 'Sertraline', medicationClass: 'SSRI', dose: '50mg',
    startDate: '2026-09-29', status: 'active', frequencyPerDay: 2, durationDays: 30,
    instructions: 'Take with food, in the morning.', prescribedByProviderId: providerId,
    prescribedAt: new Date('2026-09-29T12:00:00Z'), enteredByName: providerName,
  }).returning()
  episodeA1 = a1.id

  const [a2] = await db.insert(medicationEpisodes).values({
    patientId: patientA, name: 'Bupropion', medicationClass: 'NDRI', dose: '150mg',
    startDate: '2026-09-29', status: 'active', frequencyPerDay: 1, durationDays: 60,
    instructions: null, prescribedByProviderId: providerId,
    prescribedAt: new Date('2026-09-29T12:00:00Z'), enteredByName: 'Someone Else',
  }).returning()
  episodeA2 = a2.id

  const [b1] = await db.insert(medicationEpisodes).values({
    patientId: patientB, name: 'Atorvastatin', medicationClass: 'Statin', dose: '20mg',
    startDate: '2026-09-29', status: 'active', frequencyPerDay: 1, durationDays: 90,
    instructions: null, prescribedByProviderId: providerId,
    prescribedAt: new Date('2026-09-29T12:00:00Z'), enteredByName: providerName,
  }).returning()
  episodeB1 = b1.id

  const [imported] = await db.insert(medicationEpisodes).values({
    patientId: patientA, name: 'Imported Med', medicationClass: 'Test Class', startDate: '2025-01-01', status: 'active',
  }).returning()
  episodeAImported = imported.id
})

afterAll(async () => {
  const db = getDb()
  for (const id of [episodeA1, episodeA2, episodeB1, episodeAImported]) {
    await db.delete(medicationEpisodes).where(eq(medicationEpisodes.id, id))
  }
})

afterEach(() => {
  state.sessionRole = 'pi'
  logAudit.mockClear()
})

function page(searchParams: Record<string, string>) {
  return PrescriptionPrintPage({ searchParams: Promise.resolve(searchParams) })
}

describe('GET /prescriptions/print', () => {
  it('a valid single id renders the slip', async () => {
    const jsx = await page({ ids: String(episodeA1) })
    const { render, screen } = await import('@testing-library/react')
    render(jsx)

    expect(screen.getByText(patientAName)).toBeInTheDocument()
    expect(screen.getByText(/sertraline/i)).toBeInTheDocument()
    expect(screen.getByText(/2 times daily/i)).toBeInTheDocument()
    expect(screen.getByText(/for 30 days/i)).toBeInTheDocument()
    expect(screen.getByText(/take with food, in the morning\./i)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(providerName))).toBeInTheDocument()
    if (providerCredentials) expect(screen.getByText(new RegExp(providerCredentials))).toBeInTheDocument()
    expect(screen.getByText(providerSpecialty)).toBeInTheDocument()
    expect(screen.getByText(
      `This printout is a record of a prescription entered in ${brand.name}. It was not transmitted electronically to a pharmacy.`,
    )).toBeInTheDocument()
  })

  it('writes an audit row', async () => {
    await page({ ids: String(episodeA1) })
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('printed prescription'), patientA)
  })

  it('two ids on the same patient render one slip with two Rx blocks', async () => {
    const jsx = await page({ ids: `${episodeA1},${episodeA2}` })
    const { render, screen } = await import('@testing-library/react')
    render(jsx)

    expect(screen.getByText(/sertraline/i)).toBeInTheDocument()
    expect(screen.getByText(/bupropion/i)).toBeInTheDocument()
  })

  it('mixed-patient ids call notFound() and write no audit row', async () => {
    await expect(page({ ids: `${episodeA1},${episodeB1}` })).rejects.toThrow(NotFound)
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('an id whose prescribedAt is null calls notFound()', async () => {
    await expect(page({ ids: String(episodeAImported) })).rejects.toThrow(NotFound)
  })

  it('an unknown id calls notFound()', async () => {
    await expect(page({ ids: '999999999' })).rejects.toThrow(NotFound)
  })

  it.each([
    { label: 'missing ids entirely', params: {} as Record<string, string> },
    { label: "ids=''", params: { ids: '' } },
    { label: "ids='abc'", params: { ids: 'abc' } },
    { label: "ids='1,'", params: { ids: '1,' } },
    { label: "ids='-1'", params: { ids: '-1' } },
    { label: 'a 300-element list', params: { ids: Array.from({ length: 300 }, (_, i) => i + 1).join(',') } },
  ])('malformed ids ($label) call notFound()', async ({ params }) => {
    await expect(page(params)).rejects.toThrow(NotFound)
  })

  it('a repeated id is accepted and renders one block, not two', async () => {
    const jsx = await page({ ids: `${episodeA1},${episodeA1}` })
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(screen.getAllByText(/sertraline/i)).toHaveLength(1)
  })

  it('a crc session renders successfully', async () => {
    state.sessionRole = 'crc'
    const jsx = await page({ ids: String(episodeA1) })
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(screen.getByText(patientAName)).toBeInTheDocument()
  })

  // Printing shows the prescription as the chart does, so it follows the
  // chart's gate (CLINICAL_ROLES): every other role is redirected home
  // before any query, like every other page gate.
  it.each(['frontdesk', 'pharmacy', 'billing', 'labs', 'coder', 'collector', 'rcm'])('a %s session is redirected to / with no audit row', async (role) => {
    state.sessionRole = role
    mockRedirect.mockClear()
    logAudit.mockClear()
    await expect(page({ ids: String(episodeA1) })).rejects.toThrow(Redirect)
    expect(mockRedirect).toHaveBeenCalledWith('/')
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('there is no auto-print: the Print button is an explicit click, wrapped in the no-print contract', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined)
    const jsx = await page({ ids: String(episodeA1) })
    const { render, screen } = await import('@testing-library/react')
    render(jsx)

    expect(printSpy).not.toHaveBeenCalled()
    const button = screen.getByRole('button', { name: /print/i })
    expect(button).toBeInTheDocument()
    expect(button.closest('.no-print')).not.toBeNull()

    printSpy.mockRestore()
  })
})
