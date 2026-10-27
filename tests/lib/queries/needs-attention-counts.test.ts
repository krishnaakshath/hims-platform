import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { paymentRequests, patientPolicies, staffCredentials, staffMembers } from '@/db/schema'
import { countPoliciesExpiringBetween } from '@/lib/queries/rcm-policies'
import { countCredentialsExpiringWithin } from '@/lib/queries/staff-credentials'
import { countReportedPortalUpiRequests } from '@/lib/payments/manual-upi'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'

// WS8 T15: the SQL behind the needs-attention counts. The test DB is shared, so each case
// measures the change its own rows make.
const RUN = `${Date.now()}`.slice(-7)
const TODAY = '2026-10-24'

describe.skipIf(!process.env.DATABASE_URL)('needs-attention counts (DB)', () => {
  let b: RcmBase
  const staffIds: number[] = []
  const db = () => getDb()

  beforeAll(async () => { b = await makeRcmBase(RUN, 'T15') })
  afterAll(async () => {
    await db().delete(paymentRequests).where(eq(paymentRequests.patientId, b.patientId))
    if (staffIds.length > 0) {
      await db().delete(staffCredentials).where(inArray(staffCredentials.staffMemberId, staffIds))
      await db().delete(staffMembers).where(inArray(staffMembers.id, staffIds))
    }
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })

  it('countPoliciesExpiringBetween counts active policies ending inside the window, both ends inclusive', async () => {
    const before = await countPoliciesExpiringBetween(TODAY, '2026-10-31')
    const mk = (validTo: string, n: string, status: 'active' | 'inactive' = 'active') => db().insert(patientPolicies).values({
      patientId: b.patientId, insurerPayerId: b.insurerId, policyNumber: `POL-T15-${n}`, memberId: `M-T15-${n}`, policyType: 'individual',
      holderName: 'Holder', relationship: 'self', validFrom: '2026-01-01', validTo, priority: 'secondary', status, createdByName: 'Test',
    })
    await mk('2026-10-24', 'a') // today: in
    await mk('2026-10-31', 'b') // today + 7: in
    await mk('2026-11-01', 'c') // today + 8: out
    await mk('2026-10-23', 'd') // yesterday: out
    await mk('2026-10-27', 'e', 'inactive') // not active: out
    expect(await countPoliciesExpiringBetween(TODAY, '2026-10-31')).toBe(before + 2)
  })

  it('countCredentialsExpiringWithin splits expired from expiring within the window and ignores terminated staff', async () => {
    const before = await countCredentialsExpiringWithin(TODAY, 30)
    const staff = async (employmentStatus: 'active' | 'terminated') => {
      const [s] = await db().insert(staffMembers).values({ name: `T15 Staff ${RUN}`, department: 'Clinical', title: 'Test', hireDate: '2024-01-01', employmentStatus }).returning()
      staffIds.push(s.id)
      return s.id
    }
    const active = await staff('active')
    const gone = await staff('terminated')
    await db().insert(staffCredentials).values([
      { staffMemberId: active, credentialType: 'NMC registration', expiresOn: '2026-10-01' }, // expired
      { staffMemberId: active, credentialType: 'BLS', expiresOn: '2026-11-23' }, // today + 30: expiring
      { staffMemberId: active, credentialType: 'ACLS', expiresOn: '2026-11-24' }, // today + 31: out
      { staffMemberId: active, credentialType: 'No expiry', expiresOn: null },
      { staffMemberId: gone, credentialType: 'BLS', expiresOn: '2026-10-30' }, // terminated: out
    ])
    expect(await countCredentialsExpiringWithin(TODAY, 30)).toEqual({ expired: before.expired + 1, expiring: before.expiring + 1 })
  })

  it('countReportedPortalUpiRequests counts pending portal requests with a reported UTR inside the TTL only', async () => {
    const now = new Date()
    const before = await countReportedPortalUpiRequests(now)
    const base = { patientId: b.patientId, amountPaise: 50000, vpa: 'hospital@upi', note: 'T15', createdBy: 'Patient portal' }
    await db().insert(paymentRequests).values([
      { ...base, source: 'portal', reportedUtr: `4${RUN}00001`, reportedAt: now }, // counted
      { ...base, source: 'portal' }, // no UTR reported yet
      { ...base, source: 'staff', reportedUtr: `4${RUN}00002` }, // staff request
      { ...base, source: 'portal', reportedUtr: `4${RUN}00003`, status: 'cancelled' },
      { ...base, source: 'portal', reportedUtr: `4${RUN}00004`, createdAt: new Date(now.getTime() - 25 * 3_600_000) }, // past the TTL
    ])
    expect(await countReportedPortalUpiRequests(now)).toBe(before + 1)
  })
})
