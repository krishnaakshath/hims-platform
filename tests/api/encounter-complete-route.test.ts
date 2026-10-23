// WS2 T14: POST /api/encounters/[id]/complete answers with the visit's automatic charge outcomes and
// maps every completeEncounter refusal explicitly (DB behaviour in encounter-complete.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'pi', name: 'Probe Doctor', userId: null })) }))
vi.mock('@/lib/encounters/ownership', async () => {
  const actual = await vi.importActual<typeof import('@/lib/encounters/ownership')>('@/lib/encounters/ownership')
  return { ...actual, checkEncounterWriter: vi.fn(async () => ({ ok: true, encounter: {}, actingProviderId: 4 })) }
})
vi.mock('@/lib/queries/encounter-workspace', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/encounter-workspace')>('@/lib/queries/encounter-workspace')
  return { ...actual, completeEncounter: vi.fn() }
})

import { POST } from '@/app/api/encounters/[id]/complete/route'
import { completeEncounter } from '@/lib/queries/encounter-workspace'

const ENCOUNTER = {
  id: 3, patientId: 'RD-0001', encounterType: 'opd', visitType: 'new', status: 'completed', encounterDate: '2026-10-07', opdToken: 4,
  departmentId: 2, providerId: 4, appointmentId: null, admissionId: null, doctorAssignmentId: 11,
  checkedInByName: 'Desk A', checkedInAt: new Date('2026-10-07T04:00:00Z'), statusChangedAt: new Date('2026-10-07T05:00:00Z'),
  statusChangedByName: 'Dr K', completedAt: new Date('2026-10-07T05:00:00Z'), cancelReason: null,
}
const call = () => POST(new NextRequest('http://localhost/api/encounters/3/complete', { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: '3' }) })

beforeEach(() => { vi.mocked(completeEncounter).mockReset() })

describe('POST /api/encounters/[id]/complete (WS2 T14)', () => {
  it('returns the charge outcomes with the warnings', async () => {
    const charges = [
      { ok: true, source: 'consultation', lineId: 9, itemName: 'Consultation', taxablePaise: 60000, billTo: 'self', existing: true } as const,
    ]
    vi.mocked(completeEncounter).mockResolvedValueOnce({ ok: true, encounter: ENCOUNTER as never, warnings: ['no_vitals'], charges })
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warnings).toEqual(['no_vitals'])
    expect(body.charges).toEqual(charges)
    expect(body.encounter.id).toBe(3)
  })

  it('maps visit_billed to 409 naming the invoice, and visit_has_performed_orders to 409 with the generic message', async () => {
    vi.mocked(completeEncounter).mockResolvedValueOnce({ ok: false, error: 'visit_billed', invoiceNumber: 'INV/2026-27/000042' })
    const billed = await call()
    expect(billed.status).toBe(409)
    expect(await billed.json()).toEqual({ error: 'This visit is on invoice INV/2026-27/000042. Cancel that invoice first.', code: 'visit_billed' })
    vi.mocked(completeEncounter).mockResolvedValueOnce({ ok: false, error: 'visit_has_performed_orders' })
    const performed = await call()
    expect(performed.status).toBe(409)
    expect(await performed.json()).toEqual({ error: 'Tests or procedures on this visit have already been performed; it cannot be cancelled.', code: 'visit_has_performed_orders' })
  })

  it('invalid_transition stays 409 visit_closed', async () => {
    vi.mocked(completeEncounter).mockResolvedValueOnce({ ok: false, error: 'invalid_transition' })
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Visit is closed', code: 'visit_closed' })
  })
})
