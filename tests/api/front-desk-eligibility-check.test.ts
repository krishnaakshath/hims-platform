import { describe, it, expect, vi } from 'vitest'
import type { Role } from '@/lib/auth'
import { ALL_ROLES } from '@/lib/role-policy'

let role: Role = 'billing'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: 'Alex Billing', userId: null })) }))

import { POST } from '@/app/api/front-desk/eligibility-check/route'

// SP8: the hash-based simulated check is retired in favour of NHCX eligibility on the policy.
describe('POST /api/front-desk/eligibility-check (retired)', () => {
  it('the simulated eligibility route is retired with 410 for allowed roles and 403 for others', async () => {
    for (const r of ALL_ROLES) {
      role = r
      const res = await POST(new Request('http://localhost', { method: 'POST', body: '{not json' }))
      if (['billing', 'admin', 'crc'].includes(r)) {
        expect(res.status, r).toBe(410)
        expect(await res.json()).toEqual({ error: 'Simulated eligibility checks are retired; use the NHCX eligibility check on the patient\'s policy' })
      } else {
        expect(res.status, r).toBe(403)
      }
    }
  })
})
