import { describe, it, expect, afterAll, vi } from 'vitest'
import { eq, inArray, like, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { abdmProfileShares, auditLog, patients } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { expireShares, getSharePrefill, listPendingShares, recordProfileShare, resolveShare, sendOnShare, type ShareProfile } from '@/lib/queries/abdm-profile-shares'
import { purgeSp8Shares } from '../../db/sp8-fixtures'

const RUN = `${Date.now()}`
const PREFIX = `TEST-SP8-${RUN}`
const COUNTER = `T${RUN.slice(-8)}`
const SESSION: Session = { role: 'frontdesk', name: `TEST-SP8-shares-${RUN}`, userId: null }
const abha = (n: number) => `91${(RUN.slice(-10) + String(n)).slice(-12).padStart(12, '0')}`
const profile = (over: Partial<ShareProfile> = {}): ShareProfile => ({
  abhaNumber: abha(1), abhaAddress: `sh${RUN.slice(-8)}@sbx`, name: 'Asha Rao', gender: 'F', yearOfBirth: 1990, monthOfBirth: 3, dayOfBirth: 12,
  phone: '9876500903', addressLine: '12 MG Road', districtName: 'Mumbai', stateName: 'Maharashtra', pincode: '400001', ...over,
})
const createdPatients: string[] = []
const share = (n: number, now: Date, over: Partial<ShareProfile> = {}, counterId = COUNTER) =>
  recordProfileShare({ requestId: `${PREFIX}-${n}`, hipId: 'HFR-1', counterId, intent: 'REGISTRATION', profile: profile(over), isMock: false }, now)

describe.skipIf(!process.env.DATABASE_URL)('ABDM profile shares (DB)', () => {
  afterAll(async () => {
    await getDb().delete(auditLog).where(sql`${auditLog.userName} = ${SESSION.name}`)
    await purgeSp8Shares(PREFIX)
    if (createdPatients.length > 0) {
      await getDb().delete(auditLog).where(inArray(auditLog.patientId, createdPatients))
      await getDb().delete(patients).where(inArray(patients.id, createdPatients))
    }
  })

  it('token numbers restart per IST day and per counter; a replay is the same row', async () => {
    const day1 = new Date('2099-03-01T18:00:00Z') // 23:30 IST on 1 March
    const day2 = new Date('2099-03-01T18:31:00Z') // 00:01 IST on 2 March
    const a = await share(1, day1, { abhaNumber: abha(11) })
    const b = await share(2, day1, { abhaNumber: abha(12) })
    const c = await share(3, day2, { abhaNumber: abha(13) })
    const d = await share(4, day1, { abhaNumber: abha(14) }, `${COUNTER}B`)
    expect([a.tokenNumber, b.tokenNumber, c.tokenNumber, d.tokenNumber]).toEqual([1, 2, 1, 1])
    const again = await share(1, day1)
    expect(again).toEqual({ shareId: a.shareId, tokenNumber: 1, duplicate: true })
    const [row] = await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.id, a.shareId))
    expect(row).toMatchObject({ tokenDate: '2099-03-01', abhaNumber: abha(11), status: 'pending', ackState: 'pending' })
    const audit = await getDb().select().from(auditLog).where(sql`${auditLog.userName} = 'ABDM gateway' and ${auditLog.details} = ${`share=${a.shareId} counter=${COUNTER} intent=REGISTRATION`}`)
    expect(audit).toHaveLength(1); expect(audit[0].role).toBeNull()
  })

  it('the queue lists pending shares from the last day with a masked ABHA and an existing-patient match', async () => {
    const now = new Date()
    const pid = `TEST-SP8-${RUN.slice(-7)}-Q`
    await getDb().insert(patients).values({ id: pid, name: 'TEST-SP8 Q', dob: '1990-01-01', gender: 'female', abhaNumber: abha(21) })
    createdPatients.push(pid)
    const s = await share(21, now, { abhaNumber: abha(21), abhaAddress: null })
    const rows = (await listPendingShares(now)).filter((r) => r.id === s.shareId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ abhaMasked: `XX-XXXX-XXXX-${abha(21).slice(-4)}`, existingPatientId: pid, name: 'Asha Rao' })
    expect(JSON.stringify(rows[0])).not.toContain(abha(21))
    expect(await getSharePrefill(s.shareId)).toMatchObject({ dob: '1990-03-12', pinCode: '400001', abhaNumber: expect.stringMatching(/^\d{2}-\d{4}-\d{4}-\d{4}$/) })
  })

  it('linking a share verifies the patient ABHA via scan_and_share', async () => {
    const pid = `TEST-SP8-${RUN.slice(-7)}-L`
    await getDb().insert(patients).values({ id: pid, name: 'TEST-SP8 L', dob: '1990-01-01', gender: 'female' })
    createdPatients.push(pid)
    const s = await share(31, new Date(), { abhaNumber: abha(31), abhaAddress: `link${RUN.slice(-8)}@sbx` })
    expect(await resolveShare(s.shareId, { action: 'linked' }, SESSION)).toEqual({ ok: false, error: 'patient_required' })
    expect(await resolveShare(s.shareId, { action: 'linked', patientId: pid }, SESSION)).toEqual({ ok: true })
    const [p] = await getDb().select().from(patients).where(eq(patients.id, pid))
    expect(p).toMatchObject({ abhaNumber: abha(31), abhaVerifiedVia: 'scan_and_share', abhaVerificationSource: 'abdm' })
    expect(await resolveShare(s.shareId, { action: 'dismissed' }, SESSION)).toEqual({ ok: false, error: 'already_resolved' })
    const [row] = await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.id, s.shareId))
    expect(row).toMatchObject({ status: 'linked', patientId: pid, resolvedByName: SESSION.name })
  })

  it('linking an ABHA already on another patient is a conflict and leaves the share pending', async () => {
    const pid = `TEST-SP8-${RUN.slice(-7)}-C`
    await getDb().insert(patients).values({ id: pid, name: 'TEST-SP8 C', dob: '1990-01-01', gender: 'female' })
    createdPatients.push(pid)
    const s = await share(41, new Date(), { abhaNumber: abha(31), abhaAddress: null })
    expect(await resolveShare(s.shareId, { action: 'linked', patientId: pid }, SESSION)).toEqual({ ok: false, error: 'abha_conflict' })
    const [row] = await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.id, s.shareId))
    expect(row.status).toBe('pending')
  })

  it('a dismissed share keeps no profile; expired shares are scrubbed', async () => {
    const s = await share(51, new Date(), { abhaNumber: abha(51) })
    expect(await resolveShare(s.shareId, { action: 'dismissed' }, SESSION)).toEqual({ ok: true })
    const [d] = await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.id, s.shareId))
    expect(d).toMatchObject({ status: 'dismissed', name: null, abhaNumber: null, phone: null })

    const old = await share(52, new Date('2099-01-01T00:00:00Z'), { abhaNumber: abha(52) })
    const n = await expireShares(new Date('2099-01-02T00:00:01Z'))
    expect(n).toBeGreaterThanOrEqual(1)
    const [e] = await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.id, old.shareId))
    expect(e).toMatchObject({ status: 'expired', name: null, abhaNumber: null, abhaAddress: null, phone: null, addressLine: null, pincode: null })
  })

  it('on-share is skipped when ABDM is not configured and records the outcome when it is', async () => {
    const s = await share(61, new Date(), { abhaNumber: abha(61) })
    const env = { ABDM_GATEWAY_BASE_URL: 'https://gw.example', ABHA_BASE_URL: 'https://abha.example', ABDM_CLIENT_ID: 'c', ABDM_CLIENT_SECRET: 's', ABDM_CM_ID: 'sbx' }
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/sessions')) return new Response(JSON.stringify({ accessToken: 'GW', expiresIn: 1200 }), { status: 202 })
      return new Response('{}', { status: init?.method === 'POST' ? 202 : 404 })
    })
    try {
      await sendOnShare(s.shareId, { fetch, now: () => new Date() })
    } finally {
      vi.unstubAllEnvs()
    }
    const onShare = fetch.mock.calls.find(([u]) => String(u).endsWith('/api/hiecm/patient-share/v3/on-share'))!
    expect(JSON.parse(String(onShare[1]!.body))).toEqual({
      acknowledgement: { status: 'SUCCESS', abhaAddress: `sh${RUN.slice(-8)}@sbx`, profile: { context: COUNTER, tokenNumber: expect.any(String), expiry: 1800 } },
      response: { requestId: `${PREFIX}-61` },
    })
    const [row] = await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.id, s.shareId))
    expect(row.ackState).toBe('sent')
    expect(await getDb().select().from(abdmProfileShares).where(like(abdmProfileShares.requestId, `${PREFIX}-%`))).not.toHaveLength(0)
  })
})
