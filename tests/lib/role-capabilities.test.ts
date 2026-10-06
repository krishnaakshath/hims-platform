import { describe, it, expect } from 'vitest'
import { ROLE_CAPABILITIES } from '@/lib/role-capabilities'
import type { Role } from '@/lib/auth'

describe('ROLE_CAPABILITIES', () => {
  it('has an entry for exactly the real roles, no more, no less', () => {
    const expectedRoles: Role[] = ['crc', 'pi', 'admin', 'frontdesk', 'pharmacy', 'billing', 'labs']
    expect(new Set(Object.keys(ROLE_CAPABILITIES))).toEqual(new Set(expectedRoles))
  })

  it('gives every role a non-empty label, summary, and at least one bullet', () => {
    for (const role of Object.keys(ROLE_CAPABILITIES) as Role[]) {
      const entry = ROLE_CAPABILITIES[role]
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.summary.length).toBeGreaterThan(0)
      expect(entry.bullets.length).toBeGreaterThan(0)
    }
  })

  const has = (role: Role, re: RegExp) => ROLE_CAPABILITIES[role].bullets.some((b) => re.test(b))

  it('states the pi/admin clinical write capabilities the server actually grants', () => {
    for (const role of ['pi', 'admin'] as Role[]) {
      expect(has(role, /encounter note/i)).toBe(true)      // notes/route.ts:22, notes/[id]/sign/route.ts:9
      expect(has(role, /care plan/i)).toBe(true)           // care-plans/route.ts:19, care-plan-goals/[id]/route.ts:14
      expect(has(role, /discharge/i)).toBe(true)           // discharge/route.ts:26
      expect(has(role, /transfer/i)).toBe(true)            // transfer/route.ts:13
      expect(has(role, /inpatient medication|MAR/i)).toBe(true)  // medications/route.ts:37, administer/route.ts:16
    }
  })

  it('states patient registration for the two roles that can do it', () => {
    // patients/route.ts:45 -- admin/frontdesk exclusively; crc had this
    // removed per explicit product direction (DashboardHomeClient.tsx's
    // canAddPatient comment, CoordinatorDashboard.tsx:64 passes false).
    for (const role of ['frontdesk', 'admin'] as Role[]) {
      expect(has(role, /register a new patient/i)).toBe(true)
    }
    expect(has('pi', /register a new patient/i)).toBe(false)
    expect(has('crc', /register a new patient/i)).toBe(false)
  })

  it('states room transfer for crc and frontdesk too', () => {
    // transfer/route.ts:13 admits all four roles; the action lives on
    // patients/[anonId]/page.tsx:153, not on the bed board, so neither role's
    // existing bed-board bullet covers it
    expect(has('crc', /transfer/i)).toBe(true)
    expect(has('frontdesk', /transfer/i)).toBe(true)
  })

  it('does not claim the pi bed board is scoped to their own patients', () => {
    // inpatient/beds/page.tsx:9-21 passes the entire board to BedBoard for all
    // four admitted roles; nothing filters by provider
    expect(ROLE_CAPABILITIES.pi.bullets.some((b) => /for their admitted patients/i.test(b))).toBe(false)
  })

  it('leaves both summary paragraphs untouched -- the new gates make them true as written', () => {
    expect(ROLE_CAPABILITIES.pi.summary).toMatch(/not shown here/)
    expect(ROLE_CAPABILITIES.frontdesk.summary).toMatch(/not the clinical evidence-review, lab, or insurance tools/)
  })

  it('states trial compliance (AE/drug accountability/regulatory binder) write access for crc, pi, and admin', () => {
    // trials/[trialId]/page.tsx:43 -- canWriteCompliance is crc/pi/admin
    for (const role of ['crc', 'pi', 'admin'] as Role[]) {
      expect(has(role, /adverse event/i)).toBe(true)
      expect(has(role, /drug accountability/i)).toBe(true)
      expect(has(role, /regulatory binder/i)).toBe(true)
    }
  })

  it('names imaging attachment on the admin and pi capability bullets', () => {
    for (const role of ['admin', 'pi'] as const) {
      expect(ROLE_CAPABILITIES[role].bullets.join(' ')).toContain('attach imaging results')
    }
    expect(ROLE_CAPABILITIES.frontdesk.bullets.join(' ')).not.toContain('attach imaging')
    expect(ROLE_CAPABILITIES.crc.bullets.join(' ')).not.toContain('attach imaging')
  })
})
