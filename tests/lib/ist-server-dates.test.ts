// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'

// Wave A (P1-29): server-side "today", hour buckets and month buckets are IST,
// whatever zone the server process runs in (UTC on Vercel; LA here to prove it).
vi.mock('@/db/client', () => ({ getDb: () => { throw new Error('no db in this test') } }))
const ORIGINAL_TZ = process.env.TZ
beforeAll(() => { process.env.TZ = 'America/Los_Angeles' })
afterAll(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ })
afterEach(() => { vi.useRealTimers() })

describe('dashboard buckets use IST', () => {
  it('peak hours bucket a 09:00 IST appointment as 8–10 AM IST', async () => {
    const { computePeakHourRange } = await import('@/lib/queries/dashboard')
    expect(computePeakHourRange([new Date('2026-10-08T03:30:00Z'), new Date('2026-10-09T03:45:00Z')])).toBe('8:00 AM – 10:00 AM')
  })
  it('patients-by-month counts a patient added 00:30 IST on 1 Jan in January of the IST year', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
    const { computePatientsByMonth } = await import('@/lib/queries/dashboard')
    const rows = computePatientsByMonth([new Date('2025-12-31T19:00:00Z')]) // 00:30 IST 1 Jan 2026
    expect(rows[0].count).toBe(1)
    expect(rows[11].count).toBe(0)
  })
})

describe('ages use the IST calendar date', () => {
  it('workbook calculateAge turns over on the IST birthday', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T19:00:00Z')) // 00:30 IST 8 Oct; still 7 Oct in LA and UTC
    const { calculateAge } = await import('@/lib/queries/workbook')
    expect(calculateAge('2000-10-08')).toBe(26)
  })
})
