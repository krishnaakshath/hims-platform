// SP6 Task 13: the chart's "Visit coding" panel. Doctors (pi) propose codes while coding is
// open, answer coding queries, and crc sees everything read-only.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import type { ChartEncounterCoding } from '@/lib/queries/coding-workspace'
import type { EncounterCodingStatus } from '@/lib/coding/status'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { EncounterCodingPanel } from '@/components/coding/EncounterCodingPanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); refresh.mockReset() })

let nextId = 1
function enc(codingStatus: EncounterCodingStatus, o: Partial<ChartEncounterCoding> = {}): ChartEncounterCoding {
  const id = nextId++
  return {
    encounterId: id,
    encounterDate: '2026-03-01',
    encounterType: 'opd',
    encounterStatus: 'completed',
    providerName: 'Dr. Asha Rao',
    codingStatus,
    diagnoses: [{
      id: 100 + id, description: 'Type 2 diabetes', type: 'primary', codingStatus: 'proposed', sequence: null,
      proposedByName: 'Dr. Asha Rao', codedByName: null, codeId: 9, kind: 'icd10', code: 'E11.9', display: 'Type 2 diabetes mellitus', version: '2019', isSample: false,
    }],
    procedures: [{
      id: 200 + id, description: 'Dressing', codingStatus: 'uncoded', performedOn: '2026-03-01', performedByName: null, serviceId: null,
      serviceName: null, sequence: null, proposedByName: null, codeId: null, kind: null, code: '', display: null, version: null, isSample: false,
    }],
    openQueries: [],
    ...o,
  }
}

const query = (id: number) => ({
  id, status: 'open' as const, question: 'Is the diabetes type 1 or type 2?', addressedToProviderId: 3, addressedToName: 'Dr. Asha Rao',
  raisedByName: 'Coder Asha', raisedAt: new Date('2026-03-02T05:00:00Z'), responses: [],
})

describe('EncounterCodingPanel', () => {
  it('a pi can propose on an in-progress visit but not on a coded one', () => {
    render(<EncounterCodingPanel patientId="RD-0001" encounters={[enc('in_progress'), enc('coded')]} canPropose canRespond />)
    expect(screen.getAllByRole('button', { name: /propose diagnosis/i })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /add procedure/i })).toHaveLength(1)
    expect(screen.getByText(/coding is closed for this visit/i)).toBeInTheDocument()
  })

  it('shows each visit with its status, entries and chips', () => {
    render(<EncounterCodingPanel patientId="RD-0001" encounters={[enc('queried')]} canPropose={false} canRespond={false} />)
    expect(screen.getByText('Query open')).toBeInTheDocument()
    expect(screen.getByText('Type 2 diabetes')).toBeInTheDocument()
    expect(screen.getByText('E11.9')).toBeInTheDocument()
    expect(screen.getByText('Proposed by Dr. Asha Rao')).toBeInTheDocument()
    expect(screen.getByText('Dressing')).toBeInTheDocument()
    expect(screen.getByText('Uncoded')).toBeInTheDocument()
    expect(screen.getByText('1 Mar 2026 · OPD · Dr. Asha Rao')).toBeInTheDocument()
  })

  it('says so when there are no visits', () => {
    render(<EncounterCodingPanel patientId="RD-0001" encounters={[]} canPropose canRespond />)
    expect(screen.getByText(/no visits to code yet/i)).toBeInTheDocument()
  })

  it('crc sees the panel read-only', () => {
    render(<EncounterCodingPanel patientId="RD-0001" encounters={[enc('in_progress', { openQueries: [query(5)] })]} canPropose={false} canRespond={false} />)
    expect(screen.getByText('Is the diabetes type 1 or type 2?')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByText(/coding is closed for this visit/i)).toBeNull()
  })

  it('posts a reply to the query route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 77 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<EncounterCodingPanel patientId="RD-0001" encounters={[enc('queried', { openQueries: [query(5)] })]} canPropose canRespond />)
    fireEvent.change(screen.getByRole('textbox', { name: /reply to the coding query/i }), { target: { value: 'Type 2, on metformin' } })
    fireEvent.click(screen.getByRole('button', { name: /send reply/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/coding/queries/5/responses')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ body: 'Type 2, on metformin' }) })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('shows a refused reply in an alert', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })))
    render(<EncounterCodingPanel patientId="RD-0001" encounters={[enc('queried', { openQueries: [query(6)] })]} canPropose canRespond />)
    fireEvent.change(screen.getByRole('textbox', { name: /reply to the coding query/i }), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /send reply/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('proposes a free-text diagnosis with a type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 9, warnings: [] }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const e = enc('uncoded')
    render(<EncounterCodingPanel patientId="RD-0001" encounters={[e]} canPropose canRespond />)
    fireEvent.click(screen.getByRole('button', { name: /propose diagnosis/i }))
    const form = screen.getByRole('form', { name: /propose a diagnosis/i })
    fireEvent.click(within(form).getByRole('radio', { name: /describe it/i }))
    fireEvent.change(within(form).getByRole('textbox', { name: /diagnosis description/i }), { target: { value: 'Chest pain' } })
    fireEvent.change(within(form).getByRole('combobox', { name: /^type$/i }), { target: { value: 'provisional' } })
    fireEvent.click(within(form).getByRole('button', { name: /^propose$/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/coding/encounters/${e.encounterId}/diagnoses`)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ type: 'provisional', description: 'Chest pain' })
  })

  it('adds a free-text procedure with its date', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 9, warnings: [] }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const e = enc('in_progress')
    render(<EncounterCodingPanel patientId="RD-0001" encounters={[e]} canPropose canRespond />)
    fireEvent.click(screen.getByRole('button', { name: /add procedure/i }))
    const form = screen.getByRole('form', { name: /add a procedure/i })
    fireEvent.click(within(form).getByRole('radio', { name: /describe it/i }))
    fireEvent.change(within(form).getByRole('textbox', { name: /procedure description/i }), { target: { value: 'Wound dressing' } })
    fireEvent.click(within(form).getByRole('button', { name: /^add$/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/coding/encounters/${e.encounterId}/procedures`)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ performedOn: '2026-03-01', description: 'Wound dressing' })
  })
})
