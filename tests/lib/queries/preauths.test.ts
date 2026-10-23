import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq, inArray, like } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { randomUUID } from 'node:crypto'
import { admissionCoverage, admissions, auditLog, claims, coverageVerifications, nhcxExchanges, patientPolicies, payerProfiles, preauthEvents, preauths, rcmQueries, roomCategories, rooms, serviceCatalog, tariffRates } from '@/db/schema'
import type { Session } from '@/lib/auth'

vi.mock('@/lib/blob-store', () => ({ putPrivateBlob: vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` })), streamPrivateBlob: vi.fn() }))
import { applyPreauthAction, createPreauth, estimateForPolicy, estimatePreauth, getPreauthDetail, getPreauthDocumentBlob, listPreauths, preauthDefaultsFor, uploadPreauthDocument } from '@/lib/queries/preauths'
import { snapshotSha256 } from '@/lib/rcm/hash'
import type { PreauthCreateInput } from '@/lib/rcm/validation'
import { makePreauthWorld, destroyPreauthWorld, type PreauthWorld } from './preauth-world'
import { purgeSp8Fixtures } from '../../db/sp8-fixtures'
import { purgeCoverageFixtures } from '../../db/ws12-fixtures'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST-SP7-${RUN} Preauth Probe`
const RCM: Session = { role: 'rcm', name: PROBE, userId: null }
const NOW = new Date('2099-06-01T06:00:00Z')

describe.skipIf(!process.env.DATABASE_URL)('pre-authorisations (DB)', () => {
  let w: PreauthWorld
  const create = (over: Partial<PreauthCreateInput> = {}): PreauthCreateInput => ({
    policyId: w.policyId, claimType: 'opd', encounterId: w.encounterId, plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 1,
    treatingProviderId: w.providerId, diagnosisCodeIds: [w.dxId], procedureCodeIds: [w.pxId], estimate: [{ serviceId: w.pricedServiceId, quantity: 2 }], ...over,
  })
  beforeAll(async () => { w = await makePreauthWorld(RUN, 'A') })
  const t8 = { roomIds: [] as number[], serviceIds: [] as number[], categoryIds: [] as number[] }
  afterAll(async () => {
    await purgeCoverageFixtures([w.patientId], { dropAdmissions: true })
    if (t8.roomIds.length > 0) await getDb().delete(rooms).where(inArray(rooms.id, t8.roomIds))
    if (t8.serviceIds.length > 0) {
      await getDb().delete(tariffRates).where(inArray(tariffRates.serviceId, t8.serviceIds))
      await getDb().delete(serviceCatalog).where(inArray(serviceCatalog.id, t8.serviceIds))
    }
    if (t8.categoryIds.length > 0) await getDb().delete(roomCategories).where(inArray(roomCategories.id, t8.categoryIds))
    await purgeSp8Fixtures([w.patientId])
    await destroyPreauthWorld(w)
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  it('estimates from the payer tariff and refuses an unpriced service with its code', async () => {
    expect(await estimatePreauth({ payerId: w.tpaId, onDate: '2026-10-01', roomCategoryCode: null, items: [{ serviceId: w.pricedServiceId, quantity: 2 }] }))
      .toMatchObject({ ok: true, value: { totalPaise: 100_000_00, lines: [{ quantity: 2, unitPricePaise: 50_000_00, amountPaise: 100_000_00, priceSource: 'base' }] } })
    expect(await estimatePreauth({ payerId: w.tpaId, onDate: '2026-10-01', roomCategoryCode: null, items: [{ serviceId: w.unpricedServiceId, quantity: 1 }] }))
      .toEqual({ ok: false, error: 'price_unresolved', message: `No tariff rate covers ${w.unpricedCode}` })
    expect(await estimatePreauth({ payerId: w.tpaId, onDate: '2026-10-01', roomCategoryCode: null, items: [{ serviceId: 2147483000, quantity: 1 }] })).toEqual({ ok: false, error: 'service_not_found' })
  })

  it('creates a draft pre-auth with a PA number, snapshotted codes and the estimate', async () => {
    const r = await createPreauth(create(), RCM, NOW)
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.value.preauthNumber).toMatch(/^PA-2099-\d{6}$/)
    const [row] = await getDb().select().from(preauths).where(eq(preauths.id, r.value.preauthId))
    expect(row).toMatchObject({ status: 'draft', estimatedPaise: 100_000_00, requestedPaise: 100_000_00, insurerPayerId: w.insurerId, tpaPayerId: w.tpaId })
    expect(row.diagnoses).toEqual([{ kind: 'icd10', code: 'U1Z.1', display: 'TEST fictional diagnosis', version: `TEST-SP7-${RUN}A-dx` }])
    const [audit] = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), like(auditLog.action, 'rcm: created pre-authorisation')))
    expect(audit.details).toBe(`preauth=${row.id} number=${row.preauthNumber} estimate=10000000`)
  })

  it('refuses a diagnosis id of a procedure kind, another patient\'s visit and a missing policy', async () => {
    expect(await createPreauth(create({ diagnosisCodeIds: [w.pxId] }), RCM, NOW)).toEqual({ ok: false, error: 'code_not_found' })
    expect(await createPreauth(create({ encounterId: 2147483000 }), RCM, NOW)).toEqual({ ok: false, error: 'context_mismatch' })
    expect(await createPreauth(create({ policyId: 2147483000 }), RCM, NOW)).toEqual({ ok: false, error: 'policy_not_found' })
  })

  const newPreauth = async () => { const r = await createPreauth(create(), RCM, NOW); if (!r.ok) throw new Error(r.error); return r.value.preauthId }
  const approve = (ref: string) => ({ action: 'approve' as const, approvedPaise: 80_000_00, approvalReference: ref, validUntil: '2026-10-31', decidedOn: '2026-10-01' })

  it('walks draft -> requested -> queried -> requested -> approved and snapshots the request', async () => {
    const id = await newPreauth()
    expect(await applyPreauthAction(id, { action: 'request' }, RCM, NOW)).toEqual({ ok: true, value: { status: 'requested' } })
    expect((await applyPreauthAction(id, { action: 'record_query', question: 'Send the scan', raisedOn: '2026-10-01', dueOn: '2026-10-03' }, RCM, NOW)).ok).toBe(true)
    const [q] = await getDb().select().from(rcmQueries).where(eq(rcmQueries.preauthId, id))
    expect(await applyPreauthAction(id, { action: 'respond_query', queryId: 2147483000, body: 'x', respondedOn: '2026-10-02' }, RCM, NOW)).toEqual({ ok: false, error: 'query_not_found' })
    expect(await applyPreauthAction(id, { action: 'respond_query', queryId: q.id, body: 'Scan attached', respondedOn: '2026-10-02' }, RCM, NOW)).toEqual({ ok: true, value: { status: 'requested' } })
    expect(await applyPreauthAction(id, { action: 'respond_query', queryId: q.id, body: 'again', respondedOn: '2026-10-02' }, RCM, NOW)).toEqual({ ok: false, error: 'invalid_transition' })
    expect(await applyPreauthAction(id, approve(`AR/${RUN}/1`), RCM, NOW)).toEqual({ ok: true, value: { status: 'approved' } })
    const [row] = await getDb().select().from(preauths).where(eq(preauths.id, id))
    expect(row).toMatchObject({ approvedPaise: 80_000_00, approvalReference: `AR/${RUN}/1`, validUntil: '2026-10-31', firstRequestedAt: NOW })
    const events = await getDb().select().from(preauthEvents).where(eq(preauthEvents.preauthId, id))
    const req = events.find((e) => e.action === 'request')!
    expect(req.snapshot?.preauthNumber).toBe(row.preauthNumber); expect(req.snapshotSha256).toBe(snapshotSha256(req.snapshot))
    expect(req.snapshot?.patient.abhaNumber).toBeNull(); expect(JSON.stringify(req.snapshot)).not.toMatch(/phone|email|address/i)
    expect(events.map((e) => e.action)).toEqual(['request', 'record_query', 'respond_query', 'approve'])
  })

  it('an enhancement must exceed the approval; a rejected enhancement keeps the approval', async () => {
    const id = await newPreauth()
    await applyPreauthAction(id, { action: 'request' }, RCM, NOW)
    await applyPreauthAction(id, approve(`AR/${RUN}/2`), RCM, NOW)
    expect(await applyPreauthAction(id, { action: 'request_enhancement', requestedPaise: 80_000_00, note: 'longer stay' }, RCM, NOW))
      .toEqual({ ok: false, error: 'amounts_invalid', message: 'The enhancement must be more than the approved ₹80,000.00' })
    expect((await applyPreauthAction(id, { action: 'request_enhancement', requestedPaise: 1_00_000_00, note: 'longer stay' }, RCM, NOW)).ok).toBe(true)
    expect(await applyPreauthAction(id, { action: 'reject_enhancement', reasonCode: 'NME', decidedOn: '2026-10-02' }, RCM, NOW)).toEqual({ ok: false, error: 'code_not_found' })
    expect(await applyPreauthAction(id, { action: 'reject_enhancement', reasonCode: 'EXCL', decidedOn: '2026-10-02' }, RCM, NOW)).toEqual({ ok: true, value: { status: 'approved' } })
    await applyPreauthAction(id, { action: 'request_enhancement', requestedPaise: 1_00_000_00, note: 'longer stay' }, RCM, NOW)
    expect(await applyPreauthAction(id, { action: 'approve_enhancement', approvedPaise: 90_000_00, validUntil: '2026-11-15', decidedOn: '2026-10-03' }, RCM, NOW)).toEqual({ ok: true, value: { status: 'enhanced' } })
    await applyPreauthAction(id, { action: 'request_enhancement', requestedPaise: 1_00_000_00, note: 'even longer' }, RCM, NOW)
    expect(await applyPreauthAction(id, { action: 'reject_enhancement', reasonCode: 'EXCL', decidedOn: '2026-10-04' }, RCM, NOW)).toEqual({ ok: true, value: { status: 'enhanced' } })
    const [row] = await getDb().select().from(preauths).where(eq(preauths.id, id))
    expect(row).toMatchObject({ approvedPaise: 90_000_00, validUntil: '2026-11-15' })
  })

  it('the same approval reference for the same insurer is duplicate_reference', async () => {
    const a = await newPreauth(); const b = await newPreauth()
    for (const id of [a, b]) await applyPreauthAction(id, { action: 'request' }, RCM, NOW)
    expect((await applyPreauthAction(a, approve(`AR/${RUN}/DUP`), RCM, NOW)).ok).toBe(true)
    expect(await applyPreauthAction(b, approve(`ar/${RUN}/dup`), RCM, NOW)).toEqual({ ok: false, error: 'duplicate_reference' })
  })

  it('a pre-auth on a submitted claim cannot be cancelled', async () => {
    const id = await newPreauth()
    await applyPreauthAction(id, { action: 'request' }, RCM, NOW)
    await applyPreauthAction(id, approve(`AR/${RUN}/3`), RCM, NOW)
    await getDb().insert(claims).values({
      claimNumber: `CLM-2099-P${RUN}`, patientId: w.patientId, policyId: w.policyId, insurerPayerId: w.insurerId, tpaPayerId: w.tpaId, billingPayerId: w.tpaId,
      claimType: 'opd', encounterId: w.encounterId, preauthId: id, status: 'submitted', createdByName: 'T',
    })
    expect(await applyPreauthAction(id, { action: 'cancel', note: 'patient left' }, RCM, NOW)).toEqual({ ok: false, error: 'preauth_in_use' })
  })

  it('concurrent approvals: one wins, the other is invalid_transition; approve and cancel never lose an update', async () => {
    const id = await newPreauth()
    await applyPreauthAction(id, { action: 'request' }, RCM, NOW)
    const [x, y] = await Promise.all([applyPreauthAction(id, approve(`AR/${RUN}/4`), RCM, NOW), applyPreauthAction(id, approve(`AR/${RUN}/5`), RCM, NOW)])
    expect([x.ok, y.ok].sort()).toEqual([false, true]); expect(x.ok ? y : x).toEqual({ ok: false, error: 'invalid_transition' })
    const id2 = await newPreauth()
    await applyPreauthAction(id2, { action: 'request' }, RCM, NOW)
    await Promise.all([applyPreauthAction(id2, approve(`AR/${RUN}/6`), RCM, NOW), applyPreauthAction(id2, { action: 'cancel', note: 'no longer needed' }, RCM, NOW)])
    const [row] = await getDb().select().from(preauths).where(eq(preauths.id, id2))
    expect(row.status).toBe('cancelled')
    const events = await getDb().select().from(preauthEvents).where(eq(preauthEvents.preauthId, id2))
    expect(events.at(-1)?.toStatus).toBe('cancelled')
  })

  it('audit details carry no reference, question or note', async () => {
    const rows = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), like(auditLog.action, 'rcm: pre-authorisation %')))
    expect(rows.length).toBeGreaterThan(5)
    for (const r of rows) expect(`${r.details}`).not.toMatch(/AR\/|scan|stay|patient left|needed/i)
    expect(rows.find((r) => r.action === 'rcm: pre-authorisation approve')?.details).toMatch(/^preauth=\d+ from=(requested|queried) to=approved amount=8000000$/)
  })

  // ---- WS12 T7: refresh_snapshot -------------------------------------------------------------
  const LATER = new Date(NOW.getTime() + 60_000)
  const REFRESH = { action: 'refresh_snapshot' as const }
  const setTpaCode = (code: string | null) => getDb().update(payerProfiles).set({ nhcxParticipantCode: code }).where(eq(payerProfiles.payerId, w.tpaId))
  const eventsOf = async (id: number) => (await getDb().select().from(preauthEvents).where(eq(preauthEvents.preauthId, id))).sort((a, b) => a.id - b.id)
  const outbound = async (id: number, eventId: number, state: 'sent' | 'send_failed' | 'pending_send' | 'error') => (await getDb().insert(nhcxExchanges).values({
    entityType: 'preauth', direction: 'outbound', action: 'preauth/submit', correlationId: randomUUID(), apiCallId: randomUUID(), senderCode: 'sandbox-mock@sbx',
    recipientCode: 'TPA-OLD@sbx', state, patientId: w.patientId, policyId: w.policyId, preauthId: id, preauthEventId: eventId, bodySha256: 'a'.repeat(64), isMock: true,
  }).returning())[0]

  it('refresh_snapshot appends a fresh snapshot with the status unchanged; nothing changed is not_ready', async () => {
    await setTpaCode(null)
    const id = await newPreauth()
    expect(await applyPreauthAction(id, REFRESH, RCM, NOW)).toEqual({ ok: false, error: 'invalid_transition' })
    await applyPreauthAction(id, { action: 'request' }, RCM, NOW)
    expect(await applyPreauthAction(id, REFRESH, RCM, LATER)).toEqual({ ok: false, error: 'not_ready', message: 'Nothing has changed since this request was prepared' })
    await setTpaCode(`TPA${RUN}R1@sbx`)
    expect(await applyPreauthAction(id, REFRESH, RCM, LATER)).toEqual({ ok: true, value: { status: 'requested' } })
    const events = await eventsOf(id)
    expect(events.map((e) => e.action)).toEqual(['request', 'refresh_snapshot'])
    const [req, ref] = events
    expect(ref).toMatchObject({ fromStatus: 'requested', toStatus: 'requested', amountPaise: null })
    expect(ref.snapshot?.kind).toBe('initial'); expect(ref.snapshot?.requestedPaise).toBe(req.snapshot?.requestedPaise)
    expect(ref.snapshot?.policy.tpa?.nhcxParticipantCode).toBe(`TPA${RUN}R1@sbx`); expect(req.snapshot?.policy.tpa?.nhcxParticipantCode).toBeNull()
    expect(ref.snapshotSha256).toBe(snapshotSha256(ref.snapshot)); expect(ref.snapshotSha256).not.toBe(req.snapshotSha256)
    const [row] = await getDb().select().from(preauths).where(eq(preauths.id, id))
    expect(row).toMatchObject({ status: 'requested', requestedPaise: 100_000_00 })
    expect(await applyPreauthAction(id, REFRESH, RCM, LATER)).toEqual({ ok: false, error: 'not_ready', message: 'Nothing has changed since this request was prepared' })
    const [a] = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'rcm: pre-authorisation refresh_snapshot')))
    expect(a.details).toBe(`preauth=${id} from=requested to=requested`)
    await applyPreauthAction(id, approve(`AR/${RUN}/R1`), RCM, LATER)
    await setTpaCode(`TPA${RUN}R1b@sbx`)
    expect(await applyPreauthAction(id, REFRESH, RCM, LATER)).toEqual({ ok: false, error: 'invalid_transition' })
  })

  it('refresh_snapshot is refused once NHCX has the latest snapshot, and allowed after a failed send', async () => {
    await setTpaCode(null)
    const id = await newPreauth()
    await applyPreauthAction(id, { action: 'request' }, RCM, NOW)
    const [req] = await eventsOf(id)
    const x = await outbound(id, req.id, 'sent')
    await setTpaCode(`TPA${RUN}R2@sbx`)
    for (const state of ['sent', 'pending_send'] as const) {
      await getDb().update(nhcxExchanges).set({ state }).where(eq(nhcxExchanges.id, x.id))
      expect(await applyPreauthAction(id, REFRESH, RCM, LATER)).toEqual({ ok: false, error: 'preauth_in_use', message: 'Already sent through NHCX; the insurer has this version' })
    }
    await getDb().update(nhcxExchanges).set({ state: 'send_failed' }).where(eq(nhcxExchanges.id, x.id))
    expect(await applyPreauthAction(id, REFRESH, RCM, LATER)).toEqual({ ok: true, value: { status: 'requested' } })
  })

  it('an enhancement request refreshes as an enhancement with the same amount', async () => {
    await setTpaCode(null)
    const id = await newPreauth()
    await applyPreauthAction(id, { action: 'request' }, RCM, NOW)
    await applyPreauthAction(id, approve(`AR/${RUN}/R3`), RCM, NOW)
    await applyPreauthAction(id, { action: 'request_enhancement', requestedPaise: 1_00_000_00, note: 'longer stay' }, RCM, NOW)
    await setTpaCode(`TPA${RUN}R3@sbx`)
    expect(await applyPreauthAction(id, REFRESH, RCM, LATER)).toEqual({ ok: true, value: { status: 'enhancement_requested' } })
    const ref = (await eventsOf(id)).at(-1)!
    expect(ref).toMatchObject({ action: 'refresh_snapshot', fromStatus: 'enhancement_requested', toStatus: 'enhancement_requested' })
    expect(ref.snapshot).toMatchObject({ kind: 'enhancement', requestedPaise: 1_00_000_00 })
  })

  it('two concurrent refreshes append one event; the other finds nothing changed', async () => {
    await setTpaCode(null)
    const id = await newPreauth()
    await applyPreauthAction(id, { action: 'request' }, RCM, NOW)
    await setTpaCode(`TPA${RUN}R4@sbx`)
    const [x, y] = await Promise.all([applyPreauthAction(id, REFRESH, RCM, LATER), applyPreauthAction(id, REFRESH, RCM, LATER)])
    expect([x.ok, y.ok].sort()).toEqual([false, true])
    expect(x.ok ? y : x).toMatchObject({ ok: false, error: 'not_ready' })
    expect((await eventsOf(id)).filter((e) => e.action === 'refresh_snapshot')).toHaveLength(1)
  })

  // ---- WS12 T8: defaults from the admission, the coverage gate and the indicative split -------
  const categoryId = async (code: string) => {
    const [found] = await getDb().select({ id: roomCategories.id }).from(roomCategories).where(eq(roomCategories.code, code)).limit(1)
    if (found) return found.id
    const [made] = await getDb().insert(roomCategories).values({ code, name: `Test ${code}` }).returning({ id: roomCategories.id })
    t8.categoryIds.push(made.id)
    return made.id
  }
  const room = async (code: string) => {
    const [r] = await getDb().insert(rooms).values({ ward: `TEST-WS12-${RUN}`, roomNumber: `R${t8.roomIds.length + 1}`, bedNumber: '1', roomCategoryId: await categoryId(code) }).returning({ id: rooms.id })
    t8.roomIds.push(r.id)
    return r.id
  }

  it('preauthDefaultsFor: an ICU admission gives the attending doctor, its IST date, ICU and the primary policy', async () => {
    const [adm] = await getDb().insert(admissions).values({
      patientId: w.patientId, attendingProviderId: w.providerId, currentRoomId: await room('ICU'), admittedAt: new Date('2026-10-19T20:00:00Z'), status: 'admitted',
    }).returning({ id: admissions.id })
    const expected = { admissionId: adm.id, encounterId: null, claimType: 'ipd', plannedAdmissionDate: '2026-10-20', treatingProviderId: w.providerId, policyId: w.policyId, roomCategoryCode: 'ICU' }
    expect(await preauthDefaultsFor(w.patientId, { admissionId: adm.id }, NOW)).toEqual(expected)
    // The only active admission is used when no id is given.
    expect(await preauthDefaultsFor(w.patientId, {}, NOW)).toEqual(expected)
    // Another patient's admission id is ignored.
    expect(await preauthDefaultsFor(w.patientId, { admissionId: 2147483000 }, NOW)).toEqual(expected)

    // admission_coverage.policy_id wins over the primary policy.
    const [second] = await getDb().insert(patientPolicies).values({
      patientId: w.patientId, insurerPayerId: w.insurerId, tpaPayerId: w.tpaId, policyNumber: 'POL-T8', memberId: 'MEM-T8', policyType: 'individual',
      holderName: 'Holder', relationship: 'self', validFrom: '2026-04-01', validTo: '2099-12-31', priority: 'secondary', createdByName: 'Test',
    }).returning({ id: patientPolicies.id })
    await getDb().insert(admissionCoverage).values({ admissionId: adm.id, mode: 'cashless', policyId: second.id, coverageState: 'unverified', recordedByName: 'Test' })
    expect(await preauthDefaultsFor(w.patientId, { admissionId: adm.id }, NOW)).toMatchObject({ policyId: second.id })

    // A visit: OPD with the visit's doctor and date.
    expect(await preauthDefaultsFor(w.patientId, { encounterId: w.encounterId }, NOW)).toEqual({
      admissionId: null, encounterId: w.encounterId, claimType: 'opd', plannedAdmissionDate: '2026-10-01', treatingProviderId: w.providerId, policyId: w.policyId, roomCategoryCode: null,
    })
    await getDb().delete(admissionCoverage).where(eq(admissionCoverage.admissionId, adm.id))
    await getDb().update(admissions).set({ status: 'discharged', dischargedAt: NOW }).where(eq(admissions.id, adm.id))
    await getDb().delete(patientPolicies).where(eq(patientPolicies.id, second.id))
    // No active admission: nothing but the primary policy.
    expect(await preauthDefaultsFor(w.patientId, {}, NOW)).toEqual({
      admissionId: null, encounterId: null, claimType: 'ipd', plannedAdmissionDate: null, treatingProviderId: null, policyId: w.policyId, roomCategoryCode: null,
    })
  })

  const AT8 = new Date(NOW.getTime() + 10 * 86_400_000)
  it('createPreauth refuses a planned date outside the policy dates and a current inactive verification', async () => {
    expect(await createPreauth(create({ plannedAdmissionDate: '2100-01-05' }), RCM, AT8))
      .toEqual({ ok: false, error: 'policy_not_in_force', message: 'This policy is not valid on 5 Jan 2100 (valid 1 Apr 2026–31 Dec 2099)' })
    expect(await createPreauth(create({ plannedAdmissionDate: '2026-03-31' }), RCM, AT8)).toMatchObject({ ok: false, error: 'policy_not_in_force' })
    const [v] = await getDb().insert(coverageVerifications).values({
      patientId: w.patientId, policyId: w.policyId, source: 'manual', result: 'inactive', context: 'manual', method: 'phone',
      verifiedByName: 'Test Desk', verifiedAt: new Date(AT8.getTime() - 3_600_000), validUntil: new Date(AT8.getTime() + 3_600_000),
    }).returning({ id: coverageVerifications.id })
    expect(await createPreauth(create(), RCM, AT8)).toEqual({ ok: false, error: 'coverage_inactive' })
    // Once that verification is no longer current, the create goes through.
    expect((await createPreauth(create(), RCM, new Date(AT8.getTime() + 2 * 3_600_000))).ok).toBe(true)
    expect(v.id).toBeGreaterThan(0)
    await purgeCoverageFixtures([w.patientId]) // verifications are current by valid_until only
  })

  it('estimateForPolicy returns the indicative split with the room-rent warning when the room rate is over the limit', async () => {
    const code = `T8${RUN}`.slice(0, 16)
    const cat = await categoryId(code)
    const [svc] = await getDb().insert(serviceCatalog).values({ code: `TSP7${RUN}RR`, name: 'Test room day', departmentId: w.departmentId, category: 'room_rent', hsnSac: '999312', gstRateBp: 0 }).returning({ id: serviceCatalog.id })
    t8.serviceIds.push(svc.id)
    await getDb().insert(tariffRates).values({ serviceId: svc.id, scope: 'base', roomCategoryId: cat, amountPaise: 5_000_00, validFrom: '2026-01-01', createdByName: 'TEST-SP7' })
    await getDb().update(patientPolicies).set({ roomRentLimitPaise: 3_000_00, copayBp: null, sumInsuredPaise: 5_00_000_00 }).where(eq(patientPolicies.id, w.policyId))
    const r = await estimateForPolicy({ policyId: w.policyId, plannedAdmissionDate: '2026-10-01', roomCategoryCode: code, expectedLengthOfStayDays: 3, estimate: [{ serviceId: svc.id, quantity: 3 }] }, NOW)
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.value.totalPaise).toBe(15_000_00)
    expect(r.value.coverage).toEqual({
      insurerPaise: 9_000_00, patientPaise: 6_000_00,
      warnings: ['Room charge of ₹5,000.00 a day is over the policy room rent limit of ₹3,000.00 a day: ₹6,000.00 for 3 days is payable by the patient.'],
    })
    // A policy with no limits at all gives no split.
    await getDb().update(patientPolicies).set({ roomRentLimitPaise: null, sumInsuredPaise: null }).where(eq(patientPolicies.id, w.policyId))
    const none = await estimateForPolicy({ policyId: w.policyId, plannedAdmissionDate: '2026-10-01', estimate: [{ serviceId: w.pricedServiceId, quantity: 1 }] }, NOW)
    expect(none.ok && none.value.coverage).toBeNull()
  })

  it('stores a pre-auth document by hash and reads the detail and list without URLs', async () => {
    const id = await newPreauth()
    await applyPreauthAction(id, { action: 'request' }, RCM, new Date('2026-10-01T04:00:00Z'))
    const up = await uploadPreauthDocument(id, { kind: 'preauth_approval', title: 'Approval letter' }, { bytes: new TextEncoder().encode('%PDF'), contentType: 'application/pdf' }, RCM)
    expect(up.ok).toBe(true); if (!up.ok) return
    expect(await getPreauthDocumentBlob(up.value.documentId)).toMatchObject({ preauthId: id, patientId: w.patientId, contentType: 'application/pdf' })
    const d = await getPreauthDetail(id, NOW)
    expect(d?.documents[0]).toMatchObject({ kind: 'preauth_approval', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(JSON.stringify(d)).not.toMatch(/blob\.test/)
    expect(d?.patient).toEqual({ id: w.patientId, name: 'Test SP7 A', uhid: null, gender: 'female', dob: '1990-01-01', ageYears: 109 })
    expect(d?.events[0]).toMatchObject({ action: 'request', hasSnapshot: true })
    const list = await listPreauths({ q: d!.preauth.preauthNumber, now: NOW })
    expect(list.total).toBe(1); expect(list.rows[0]).toMatchObject({ id, status: 'requested', decisionOverdue: true })
  })
})

