import { describe, it, expect, afterAll } from 'vitest'
import { and, eq, like } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, payers, payerProfiles } from '@/db/schema'
import type { Session } from '@/lib/auth'
import {
  createPayerWithProfile, upsertPayerProfile, setPayerNetworks, setDocumentRequirements, setPayerContacts, getRcmPayer, listRcmPayers,
  listReasonCodes, getHospitalIdentifiers,
} from '@/lib/queries/rcm-payers'
import { purgeRcmFixtures } from '../../db/rcm-fixtures'
import type { PayerProfileInput } from '@/lib/rcm/validation'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST-SP7-${RUN} Payer Probe`
const RCM: Session = { role: 'rcm', name: PROBE, userId: null }
const PROFILE: PayerProfileInput = {
  kind: 'insurer', defaultChannel: 'portal', empanelmentStatus: 'empanelled', preauthSlaHours: 1, claimSettlementSlaDays: 30,
  queryResponseDays: 7, submissionWindowDays: 15, requiresAbha: false, requiresPreauthForIpd: true, active: true,
}

describe.skipIf(!process.env.DATABASE_URL)('rcm payers (DB)', () => {
  const ids: number[] = []
  afterAll(async () => {
    await purgeRcmFixtures([], ids)
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  it('creates a payer with its profile; legacy payers keep their row and gain a profile', async () => {
    const r = await createPayerWithProfile({ ...PROFILE, name: `Test SP7 Star ${RUN}`, code: `TSP7${RUN}S`, gstin: null, stateCode: 'IN-KA' }, RCM)
    expect(r.ok).toBe(true); if (!r.ok) return
    ids.push(r.value.payerId)
    const [p] = await getDb().select().from(payers).where(eq(payers.id, r.value.payerId))
    expect(p).toMatchObject({ payerType: 'other', stateCode: 'IN-KA' })
    expect(await createPayerWithProfile({ ...PROFILE, name: 'Dup', code: `TSP7${RUN}S` }, RCM)).toMatchObject({ ok: false, error: 'duplicate_reference', message: 'A payer with this code already exists' })

    const [legacy] = await getDb().insert(payers).values({ name: `Test SP7 Legacy ${RUN}`, payerId: `TSP7${RUN}L`, payerType: 'commercial' }).returning()
    ids.push(legacy.id)
    expect((await listRcmPayers()).find((x) => x.payerId === legacy.id)?.profile).toBeNull()
    expect(await upsertPayerProfile(legacy.id, { ...PROFILE, kind: 'tpa' }, RCM)).toEqual({ ok: true, value: null })
    const [after] = await getDb().select().from(payers).where(eq(payers.id, legacy.id))
    expect(after.payerType).toBe('commercial')
    expect((await getRcmPayer(legacy.id))?.profile?.kind).toBe('tpa')
    expect((await listRcmPayers({ kind: 'tpa' })).some((x) => x.payerId === legacy.id)).toBe(true)
    expect(await upsertPayerProfile(2147483000, PROFILE, RCM)).toMatchObject({ ok: false, error: 'payer_not_found' })
  })

  it('networks accept only TPAs for an insurer', async () => {
    const [insurer, tpa] = ids
    expect(await setPayerNetworks(insurer, [insurer], RCM)).toMatchObject({ ok: false, error: 'payer_kind_invalid' })
    expect(await setPayerNetworks(tpa, [], RCM)).toMatchObject({ ok: false, error: 'payer_kind_invalid' })
    expect((await setPayerNetworks(insurer, [tpa], RCM)).ok).toBe(true)
    expect((await getRcmPayer(insurer))?.tpaIds).toEqual([tpa])
    expect((await getRcmPayer(tpa))?.insurerIds).toEqual([insurer])
  })

  it('requirements replace the set for one claim type only', async () => {
    const [insurer] = ids
    await setDocumentRequirements(insurer, 'ipd', [{ documentKind: 'operation_notes', required: true }], RCM)
    await setDocumentRequirements(insurer, 'opd', [{ documentKind: 'claim_form', required: true }], RCM)
    await setDocumentRequirements(insurer, 'ipd', [{ documentKind: 'claim_form', required: false }, { documentKind: 'prescription', required: true }], RCM)
    const reqs = (await getRcmPayer(insurer))!.requirements.map((r) => `${r.claimType}:${r.documentKind}:${r.required}`).sort()
    expect(reqs).toEqual(['ipd:claim_form:false', 'ipd:prescription:true', 'opd:claim_form:true'])
  })

  it('audit rows carry ids and kinds only', async () => {
    const [insurer] = ids
    await setPayerContacts(insurer, [{ name: 'Ravi Kumar', phone: '9845013210', email: 'ravi@insurer.example', isEscalation: true }], RCM)
    expect((await getRcmPayer(insurer))?.contacts).toHaveLength(1)
    const rows = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), like(auditLog.action, 'rcm: %')))
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['rcm: created payer', 'rcm: updated payer profile', 'rcm: updated payer network', 'rcm: updated document requirements', 'rcm: updated payer contacts']))
    for (const r of rows) expect(`${r.details}`).not.toMatch(/Ravi|9845013210|ravi@|Star/)
    expect(rows.find((r) => r.action === 'rcm: updated payer contacts')?.details).toBe(`payer=${insurer} contacts=1`)
  })

  it('reads reason codes and the hospital identifiers', async () => {
    expect((await listReasonCodes('write_off')).map((r) => r.code)).toEqual(['SHORTPAY', 'BANK', 'ABSORB'])
    const ids2 = await getHospitalIdentifiers()
    expect(ids2).toHaveProperty('rohiniId')
    expect(await getDb().select().from(payerProfiles).where(eq(payerProfiles.payerId, ids[0]))).toHaveLength(1)
  })
})
