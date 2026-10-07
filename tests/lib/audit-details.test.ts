import { describe, it, expect, beforeEach, vi } from 'vitest'

const valuesSpy = vi.fn()
vi.mock('@/db/client', () => ({
  getDb: () => ({ insert: () => ({ values: (v: unknown) => { valuesSpy(v); return Promise.resolve() } }) }),
}))

import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'

const session: Session = { role: 'frontdesk', name: 'Asha', userId: 1 }

beforeEach(() => { valuesSpy.mockReset() })

describe('logAudit details', () => {
  it('writes details when given and null otherwise', async () => {
    await logAudit(session, 'x', 'P', 'reason: emergency')
    expect(valuesSpy).toHaveBeenLastCalledWith({ userName: 'Asha', role: 'frontdesk', action: 'x', patientId: 'P', details: 'reason: emergency' })
    await logAudit(session, 'x', 'P')
    expect(valuesSpy.mock.calls[1][0].details).toBeNull()
    await logAudit(session, 'x', null, null)
    expect(valuesSpy.mock.calls[2][0]).toMatchObject({ patientId: null, details: null })
  })

  it('redacts an Aadhaar-shaped number from action and details (defence in depth)', async () => {
    for (const form of ['234567890124', '2345 6789 0124', '2345-6789-0124']) {
      await logAudit(session, `looked up ${form}`, 'P', `number=${form};`)
      const v = valuesSpy.mock.lastCall![0]
      expect(JSON.stringify(v)).not.toMatch(/2345|6789/)
      expect(v.action).toBe('looked up [redacted]')
      expect(v.details).toBe('number=[redacted];')
    }
  })

  it('leaves non-Aadhaar digit runs alone (checksum-invalid, wrong length, leading 0/1)', async () => {
    await logAudit(session, 'invoice 234567890125 and 12345678901234 and 123456789012', 'P', 'TEST-SP1-1')
    const v = valuesSpy.mock.lastCall![0]
    expect(v.action).toBe('invoice 234567890125 and 12345678901234 and 123456789012')
    expect(v.details).toBe('TEST-SP1-1')
  })
})
