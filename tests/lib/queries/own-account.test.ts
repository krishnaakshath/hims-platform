import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const rows: { current: Record<string, unknown>[] } = { current: [] }
const where = vi.fn(async () => rows.current)
vi.mock('@/db/client', () => ({ getDb: () => ({ select: () => ({ from: () => ({ where }) }) }) }))
vi.mock('@/lib/queries/settings', () => ({
  getAdminMfaState: vi.fn(async () => ({ mfaSecretEncrypted: null, mfaEnabled: true, mfaMethod: 'email', phone: null })),
}))

import { getOwnAccount } from '@/lib/queries/own-account'

const saved = process.env.ADMIN_EMAIL
beforeEach(() => { rows.current = []; where.mockClear(); process.env.ADMIN_EMAIL = 'admin@example.test' })
afterEach(() => { process.env.ADMIN_EMAIL = saved })

describe('getOwnAccount', () => {
  it('reads the env admin from app settings', async () => {
    expect(await getOwnAccount({ role: 'admin', name: 'Admin', userId: null })).toEqual({ email: 'admin@example.test', mfaMethod: 'email', phone: null })
    expect(where).not.toHaveBeenCalled()
  })

  it('reads a staff user by session userId', async () => {
    rows.current = [{ email: 'lab@example.test', role: 'labs', mfaMethod: 'sms', phone: '+919876543210' }]
    expect(await getOwnAccount({ role: 'labs', name: 'Lab Tech', userId: 4 })).toEqual({ email: 'lab@example.test', mfaMethod: 'sms', phone: '+919876543210' })
  })

  it('refuses a users row whose role disagrees with the session', async () => {
    rows.current = [{ email: 'x@example.test', role: 'admin', mfaMethod: 'totp', phone: null }]
    expect(await getOwnAccount({ role: 'labs', name: 'Lab Tech', userId: 4 })).toEqual({ email: '', mfaMethod: 'totp', phone: null })
  })

  it('falls back to name + role for a legacy cookie without userId', async () => {
    rows.current = [{ email: 'fd@example.test', role: 'frontdesk', mfaMethod: 'totp', phone: null }]
    expect(await getOwnAccount({ role: 'frontdesk', name: 'Front Desk', userId: null })).toEqual({ email: 'fd@example.test', mfaMethod: 'totp', phone: null })
  })
})
