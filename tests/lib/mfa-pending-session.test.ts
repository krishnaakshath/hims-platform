// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import {
  setPendingStaffMfaCookie, getPendingStaffMfaSession, clearPendingStaffMfaCookie,
  setPendingPatientMfaCookie, getPendingPatientMfaSession, clearPendingPatientMfaCookie,
} from '@/lib/mfa-pending-session'

// next/headers' cookies() needs a request-scoped store; fake one in-memory
// so these can run as plain unit tests, same reasoning as vitest.setup.ts's
// existing next/headers mock but with a real settable store instead of a
// no-op one, since these tests need to read back what they set.
const store = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (store.has(name) ? { value: store.get(name) } : undefined),
    set: (name: string, value: string) => { store.set(name, value) },
    delete: (name: string) => { store.delete(name) },
  }),
}))

beforeAll(() => { vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-bytes-long') })
afterAll(() => { vi.unstubAllEnvs() })

describe('pending staff MFA session', () => {
  it('round-trips an enroll-mode session for the env admin account', async () => {
    await setPendingStaffMfaCookie({ role: 'admin', name: 'Test Admin', mode: 'enroll', userId: null, method: 'totp' })
    const session = await getPendingStaffMfaSession()
    expect(session).toEqual({ role: 'admin', name: 'Test Admin', mode: 'enroll', userId: null, method: 'totp' })
  })

  it('round-trips a verify-mode session for a DB-backed user', async () => {
    await setPendingStaffMfaCookie({ role: 'crc', name: 'Test CRC', mode: 'verify', userId: 42, method: 'sms' })
    const session = await getPendingStaffMfaSession()
    expect(session).toEqual({ role: 'crc', name: 'Test CRC', mode: 'verify', userId: 42, method: 'sms' })
  })

  it('returns null after clearing', async () => {
    await setPendingStaffMfaCookie({ role: 'admin', name: 'Test Admin', mode: 'verify', userId: null, method: 'totp' })
    await clearPendingStaffMfaCookie()
    expect(await getPendingStaffMfaSession()).toBeNull()
  })

  it('returns null with no cookie set', async () => {
    await clearPendingStaffMfaCookie()
    expect(await getPendingStaffMfaSession()).toBeNull()
  })
})

describe('pending patient MFA session', () => {
  it('round-trips a patient session', async () => {
    await setPendingPatientMfaCookie({ patientId: 'RD-0001' })
    expect(await getPendingPatientMfaSession()).toEqual({ patientId: 'RD-0001' })
  })

  it('returns null after clearing', async () => {
    await setPendingPatientMfaCookie({ patientId: 'RD-0001' })
    await clearPendingPatientMfaCookie()
    expect(await getPendingPatientMfaSession()).toBeNull()
  })
})
