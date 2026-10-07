import { describe, it, expect } from 'vitest'
import { ROLE_CAPABILITIES } from '@/lib/role-capabilities'
import type { Role } from '@/lib/auth'

describe('ROLE_CAPABILITIES', () => {
  it('has an entry for exactly the real roles, no more, no less', () => {
    const expectedRoles: Role[] = ['crc', 'pi', 'admin', 'frontdesk', 'pharmacy', 'billing', 'labs', 'coder']
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

  it('states the SP1 Aadhaar write and master-data capabilities the server grants', () => {
    // aadhaar/route.ts: AADHAAR_WRITE_ROLES (admin, crc, frontdesk); masked read is admin/crc only
    expect(has('crc', /Aadhaar with consent, seeing only its last 4 digits/)).toBe(true)
    expect(has('frontdesk', /Aadhaar with consent or the reason it was declined \(the number is never shown back\)/)).toBe(true)
    expect(has('pi', /Aadhaar/)).toBe(false)
    // settings/uhid-prefix (MASTER_DATA_ADMIN_ROLES) and the department master
    expect(has('admin', /department master and the UHID prefix/)).toBe(true)
  })

  it('states the SP2 tariff capabilities exactly for the roles the tariff gates admit', () => {
    // role-policy.ts TARIFF_MANAGE_ROLES / TARIFF_LOOKUP_ROLES
    for (const role of ['admin', 'billing'] as Role[]) expect(has(role, /service catalogue, tariffs, packages and room categories/)).toBe(true)
    for (const role of ['crc', 'frontdesk'] as Role[]) {
      expect(has(role, /Look up the current price of a service/)).toBe(true)
      expect(has(role, /Manage the service catalogue/)).toBe(false)
    }
    for (const role of ['pi', 'pharmacy', 'labs', 'coder'] as Role[]) expect(has(role, /tariff|price of a service/i)).toBe(false)
  })
})

describe('SP3 follow-up capabilities', () => {
  const has = (role: Role, re: RegExp) => ROLE_CAPABILITIES[role].bullets.some((b) => re.test(b))
  it('states the SP3 follow-up capabilities the server grants', () => {
    expect(has('pi', /follow-up plan/i)).toBe(true); expect(has('admin', /follow-up plan/i)).toBe(true)
    expect(has('frontdesk', /recall list/i)).toBe(true); expect(has('frontdesk', /follow-up plan/i)).toBe(false)
    expect(has('crc', /recall list \(read-only\)/i)).toBe(true)
  })

  // Wave C: patient identification and front-desk flow.
  it('states the Wave C identification and correction capabilities', () => {
    expect(has('frontdesk', /UHID, mobile/i)).toBe(true)
    expect(has('frontdesk', /token slip/i)).toBe(true)
    expect(has('pharmacy', /name, UHID, mobile/i)).toBe(true)
    expect(has('admin', /correct a patient's name or date of birth/i)).toBe(true)
    for (const role of ['crc', 'frontdesk', 'pi', 'pharmacy', 'billing', 'labs'] as Role[]) {
      expect(has(role, /correct a patient's name or date of birth/i), role).toBe(false)
    }
  })
})

// SP6
describe('SP6 coding capabilities', () => {
  const has = (role: Role, re: RegExp) => ROLE_CAPABILITIES[role].bullets.some((b) => re.test(b))
  it('states the coder capabilities and no clinical-note write', () => {
    expect(has('coder', /coding worklist/i)).toBe(true); expect(has('coder', /query/i)).toBe(true)
    expect(has('coder', /encounter note|care plan|prescri/i)).toBe(false); expect(has('pi', /propose diagnosis/i)).toBe(true)
    expect(has('admin', /licensed code sets/i)).toBe(true); expect(has('admin', /assign coding work/i)).toBe(true)
    expect(ROLE_CAPABILITIES.coder.label).toBe('Clinical Coder')
  })
})
// end SP6
