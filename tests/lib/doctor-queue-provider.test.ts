import { describe, it, expect } from 'vitest'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'

describe('resolveDoctorQueueProvider', () => {
  it('falls back to the last-name match for an unlinked pi session', async () => {
    const p = await resolveDoctorQueueProvider({ role: 'pi', name: 'Dr. R. Kunam', userId: null })
    expect(p?.name).toContain('Kunam')
  })

  it('returns null when nothing matches', async () => {
    expect(await resolveDoctorQueueProvider({ role: 'pi', name: 'Dr. Nobody Matchington', userId: null })).toBeNull()
  })

  // An empty last name would make includes('') match every provider, so a
  // doctor would see another provider's queue and badge.
  it.each(['', '   '])('returns null for an empty or whitespace-only name (%j)', async (name) => {
    expect(await resolveDoctorQueueProvider({ role: 'pi', name, userId: null })).toBeNull()
  })
})
