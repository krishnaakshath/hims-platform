import { describe, it, expect } from 'vitest'
import { listAppointmentsInRange, listUpcomingAppointments } from '@/lib/queries/appointments'
import { listActiveProviders } from '@/lib/queries/providers'

describe('listAppointmentsInRange', () => {
  it('returns appointments within the given range, joined with patient and provider details', async () => {
    const results = await listAppointmentsInRange(new Date('2026-09-01T00:00:00'), new Date('2026-09-30T23:59:59'))
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]).toHaveProperty('patientName')
    expect(results[0]).toHaveProperty('providerName')
    expect(results[0]).toHaveProperty('providerColorTag')
  })

  it('filters to only the given provider IDs when provided', async () => {
    const providers = await listActiveProviders()
    const oneProvider = [providers[0].id]
    const results = await listAppointmentsInRange(new Date('2026-09-01T00:00:00'), new Date('2026-09-30T23:59:59'), oneProvider)
    expect(results.every((r) => r.providerId === oneProvider[0])).toBe(true)
  })

  it('returns zero results for an explicitly empty provider filter (Uncheck All)', async () => {
    const results = await listAppointmentsInRange(new Date('2026-09-01T00:00:00'), new Date('2026-09-30T23:59:59'), [])
    expect(results).toEqual([])
  })
})

describe('listUpcomingAppointments', () => {
  it('returns only scheduled, future appointments, ordered soonest-first', async () => {
    const results = await listUpcomingAppointments(5)
    expect(results.every((r) => r.status === 'scheduled')).toBe(true)
    for (let i = 1; i < results.length; i++) {
      expect(results[i].startsAt.getTime()).toBeGreaterThanOrEqual(results[i - 1].startsAt.getTime())
    }
  })
})
