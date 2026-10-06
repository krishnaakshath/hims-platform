import { describe, it, expect, vi } from 'vitest'

// The export loads every row's patient detail and latest form submission.
// Unbounded, one export could hold all 10 pool connections and trip the
// pool's connection timeout for every other request; this pins the bound.
const state = vi.hoisted(() => ({ inFlight: 0, maxInFlight: 0, rows: 0 }))

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'admin', name: 'Test Admin', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/trials', () => ({ listAllTrials: vi.fn(async () => []) }))
vi.mock('@/lib/queries/patients', () => ({
  listPatientsWithStatus: vi.fn(async () => Array.from({ length: 17 }, (_, i) => ({
    id: `RD-T${i}`, name: `Probe ${i}`, dob: '1990-01-01', phone: null, email: null, currentProvider: null,
    referralType: null, trialId: null, overallStatus: null, lastCommunication: null,
  }))),
  getPatientDetail: vi.fn(async () => {
    state.inFlight++
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    state.inFlight--
    state.rows++
    return null
  }),
}))
vi.mock('@/db/client', () => {
  const chain = { select: () => chain, from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => [] }
  return { getDb: () => chain }
})

import { GET } from '@/app/api/workbook/export/route'
import { WORKBOOK_EXPORT_CONCURRENCY } from '@/lib/excel-export'

describe('GET /api/workbook/export fan-out', () => {
  it('loads at most WORKBOOK_EXPORT_CONCURRENCY rows at once and still exports every row', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(state.rows).toBe(17)
    // Below the pool size (10), so an export never holds every connection.
    expect(WORKBOOK_EXPORT_CONCURRENCY).toBeLessThan(10)
    expect(state.maxInFlight).toBeGreaterThan(0)
    expect(state.maxInFlight).toBeLessThanOrEqual(WORKBOOK_EXPORT_CONCURRENCY)
  })
})
