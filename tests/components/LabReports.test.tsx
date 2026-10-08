// SP5 Task 14: releasing a report from the worklist's "To report" stage, and the chart's report list.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import type { WorklistOrder } from '@/components/LabWorklist'
import { LabWorklist } from '@/components/LabWorklist'
import { LabReportList } from '@/components/labs/LabReportList'
import type { Role } from '@/lib/auth'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  refresh.mockClear()
})

let nextId = 100
function verified(overrides: Partial<WorklistOrder> = {}): WorklistOrder {
  const id = nextId++
  return {
    id, status: 'verified', orderedAt: new Date('2099-05-01T04:30:00Z'), collectedAt: null, receivedAt: null, verifiedAt: new Date('2099-05-01T08:00:00Z'),
    patientId: 'RD-1', patientName: 'Patient 1', patientUhid: 'UH-1', testId: 1, testName: `Test ${id}`, testCode: 'T', category: 'lab', attachments: [],
    orderedByProviderId: 1, orderedByProviderName: 'Dr. Test', sampleId: null, requisitionId: 10, homeCollectionVisitId: null, visitDate: null,
    result: { value: '1', unit: null, flag: 'normal', resultedByName: 'Lab Tech', amendedAt: null },
    ...overrides,
  }
}

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const renderAs = (role: Role, orders = [verified(), verified(), verified({ requisitionId: null })]) =>
  render(<LabWorklist orders={orders} labTests={[]} role={role} />)

describe('Release report (worklist "To report")', () => {
  it.each(['admin', 'pi', 'labs'] as Role[])('%s gets one Release button per requisition group', (role) => {
    renderAs(role)
    expect(screen.getAllByRole('button', { name: 'Release report' })).toHaveLength(1)
  })

  it('crc sees the stage but no Release button', () => {
    renderAs('crc')
    expect(screen.getByText(/To report \(3\)/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Release report' })).toBeNull()
  })

  it('posts to the requisition, then shows the report link and the follow-up outcome', async () => {
    const fetchMock = mockFetch(201, { report: { id: 41, reportNumber: 'LR-2099-000007', version: 1 }, followUp: { outcome: 'created', followUpOrderId: 12, dueDate: '2099-08-15' } })
    renderAs('labs')
    fireEvent.click(screen.getByRole('button', { name: 'Release report' }))
    const status = await screen.findByRole('status')
    expect(fetchMock).toHaveBeenCalledWith('/api/lab-requisitions/10/report', expect.objectContaining({ method: 'POST' }))
    expect(status).toHaveTextContent('Report LR-2099-000007 released')
    expect(status).toHaveTextContent('Follow-up visit planned for 15 Aug 2099')
    expect(within(status).getByRole('link', { name: /open report/i })).toHaveAttribute('href', '/api/lab-reports/41/download')
    expect(refresh).toHaveBeenCalled()
  })

  it('shows a version note for a re-release', async () => {
    mockFetch(201, { report: { id: 42, reportNumber: 'LR-2099-000008', version: 2 }, followUp: { outcome: 'pending', followUpOrderId: null, dueDate: null } })
    renderAs('pi')
    fireEvent.click(screen.getByRole('button', { name: 'Release report' }))
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('Report LR-2099-000008 (version 2) released')
    expect(status).toHaveTextContent('follow-up visit will be planned once every test is reported')
  })

  it('shows the route\'s 409 message in an alert and does not refresh', async () => {
    mockFetch(409, { error: 'Results changed while the report was being generated. Please try again.' })
    renderAs('labs')
    fireEvent.click(screen.getByRole('button', { name: 'Release report' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Results changed while the report was being generated. Please try again.')
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Release report' })).toBeEnabled()
  })
})

describe('LabReportList', () => {
  const R = (id: number, version: number, superseded: boolean) => ({
    id, reportNumber: `LR-2099-00000${id}`, version, releasedAt: new Date('2099-08-01T05:00:00Z'), testSummary: 'HbA1c, TSH', supersededAt: superseded ? new Date('2099-08-02T05:00:00Z') : null,
  })

  it('lists every version with a download link, marking superseded ones', () => {
    render(<LabReportList reports={[R(2, 2, false), R(1, 1, true)]} />)
    const links = screen.getAllByRole('link', { name: /download/i })
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/api/lab-reports/2/download', '/api/lab-reports/1/download'])
    expect(screen.getByText(/^Report LR-2099-000002 \(version 2\)/)).toBeInTheDocument()
    expect(screen.getAllByText(/HbA1c, TSH/)).toHaveLength(2)
    expect(screen.getByText('Superseded')).toBeInTheDocument()
    expect(screen.getAllByText(/1 Aug 2099/).length).toBeGreaterThan(0)
  })

  it('shows an empty state', () => {
    render(<LabReportList reports={[]} />)
    expect(screen.getByText('No lab reports released yet.')).toBeInTheDocument()
  })
})
