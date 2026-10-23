// WS1 T1: the shared encounter-writer check (src/lib/encounters/ownership.ts), with the encounter
// query and the doctor's provider resolver mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EncounterRow } from '@/db/schema'
import type { Session } from '@/lib/auth'

vi.mock('@/lib/queries/encounters', () => ({ getEncounterById: vi.fn() }))
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn() }))

import { checkEncounterWriter, parseEncounterId } from '@/lib/encounters/ownership'
import { getEncounterById } from '@/lib/queries/encounters'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'

const FIXED_CHECKED_IN_AT = new Date('2099-01-01T08:00:00.000Z')
const enc = (over: Partial<EncounterRow> = {}): EncounterRow => ({
  id: 12, patientId: 'RD-0001', encounterType: 'opd', visitType: 'new', status: 'in_consultation',
  encounterDate: '2099-01-01', opdToken: 1, departmentId: null, providerId: 7, appointmentId: null,
  admissionId: null, doctorAssignmentId: null, checkedInByName: 'TEST_WS1', checkedInAt: FIXED_CHECKED_IN_AT,
  statusChangedAt: null, statusChangedByName: null, completedAt: null, cancelReason: null, ...over,
})
const as = (role: Session['role']): Session => ({ role, name: 'TEST_WS1 user', userId: 1 })

describe('parseEncounterId', () => {
  it('accepts a positive int4 decimal', () => {
    expect(parseEncounterId('12')).toBe(12)
    expect(parseEncounterId('2147483647')).toBe(2147483647)
  })
  it.each(['0', '-1', '1e3', '2147483648', '', ' 12', '12.0', 'abc', '0x10'])('rejects %j', (raw) => {
    expect(parseEncounterId(raw)).toBeNull()
  })
})

describe('checkEncounterWriter', () => {
  beforeEach(() => {
    vi.mocked(getEncounterById).mockReset().mockResolvedValue(enc())
    vi.mocked(resolveDoctorQueueProvider).mockReset().mockResolvedValue({ id: 7, name: 'Dr. Owner' })
  })

  it('admin passes on any encounter, acting as no provider', async () => {
    vi.mocked(getEncounterById).mockResolvedValue(enc({ providerId: 99 }))
    const r = await checkEncounterWriter(as('admin'), 12)
    expect(r).toEqual({ ok: true, encounter: enc({ providerId: 99 }), actingProviderId: null })
    expect(resolveDoctorQueueProvider).not.toHaveBeenCalled()
  })

  it('pi on their own encounter passes with actingProviderId set', async () => {
    const r = await checkEncounterWriter(as('pi'), 12)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.actingProviderId).toBe(7)
      expect(r.encounter.id).toBe(12)
    }
  })

  it("pi on another doctor's encounter is 403 not_owner", async () => {
    vi.mocked(resolveDoctorQueueProvider).mockResolvedValue({ id: 8, name: 'Dr. Other' })
    expect(await checkEncounterWriter(as('pi'), 12)).toEqual({ ok: false, status: 403, body: { error: 'Forbidden', code: 'not_owner' } })
  })

  it('pi with no linked provider profile is 403', async () => {
    vi.mocked(resolveDoctorQueueProvider).mockResolvedValue(null)
    const r = await checkEncounterWriter(as('pi'), 12)
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  it('crc is 403 unless allowCrc', async () => {
    expect(await checkEncounterWriter(as('crc'), 12)).toEqual({ ok: false, status: 403, body: { error: 'Forbidden' } })
    expect(getEncounterById).not.toHaveBeenCalled()
    const r = await checkEncounterWriter(as('crc'), 12, { allowCrc: true })
    expect(r).toEqual({ ok: true, encounter: enc(), actingProviderId: null })
  })

  it.each(['frontdesk', 'billing', 'pharmacy', 'labs', 'coder', 'collector', 'rcm'] as const)('%s is 403 before any query', async (role) => {
    expect(await checkEncounterWriter(as(role), 12, { allowCrc: true, allowClosed: true })).toEqual({ ok: false, status: 403, body: { error: 'Forbidden' } })
    expect(getEncounterById).not.toHaveBeenCalled()
  })

  it.each(['completed', 'cancelled'] as const)('a %s encounter is 409 visit_closed, and passes with allowClosed', async (status) => {
    vi.mocked(getEncounterById).mockResolvedValue(enc({ status }))
    expect(await checkEncounterWriter(as('pi'), 12)).toEqual({ ok: false, status: 409, body: { error: 'Visit is closed', code: 'visit_closed' } })
    expect(await checkEncounterWriter(as('admin'), 12)).toMatchObject({ ok: false, status: 409 })
    expect(await checkEncounterWriter(as('pi'), 12, { allowClosed: true })).toMatchObject({ ok: true, actingProviderId: 7 })
  })

  it("ownership is checked before closed-ness (another doctor's closed visit is not_owner)", async () => {
    vi.mocked(getEncounterById).mockResolvedValue(enc({ status: 'completed' }))
    vi.mocked(resolveDoctorQueueProvider).mockResolvedValue({ id: 8, name: 'Dr. Other' })
    expect(await checkEncounterWriter(as('pi'), 12)).toMatchObject({ status: 403, body: { code: 'not_owner' } })
  })

  it('an unknown id is 404 Not found', async () => {
    vi.mocked(getEncounterById).mockResolvedValue(null)
    expect(await checkEncounterWriter(as('admin'), 404404)).toEqual({ ok: false, status: 404, body: { error: 'Not found' } })
    expect(await checkEncounterWriter(as('pi'), 404404)).toEqual({ ok: false, status: 404, body: { error: 'Not found' } })
  })
})
