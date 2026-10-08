import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import {
  preauths, preauthEvents, rcmQueries, rcmQueryResponses, preauthDocuments, claims, claimInvoices, claimSubmissions, claimDispatches,
  claimEvents, claimDocuments, claimDisallowances, claimSettlements, claimWriteOffs, chargeLines,
  preauthStatusEnum, preauthActionEnum, claimStatusEnum, claimEventActionEnum, submissionKindEnum, rcmQueryStatusEnum, writeOffStatusEnum,
  documentSourceEnum, ID_PROOF_TYPE_VALUES,
} from '@/db/schema'
import { PREAUTH_STATUSES, PREAUTH_ACTIONS } from '@/lib/rcm/preauth-status'
import { CLAIM_STATUSES, CLAIM_EVENT_ACTIONS } from '@/lib/rcm/claim-status'
import { SUBMISSION_KINDS, RCM_QUERY_STATUSES, WRITE_OFF_STATUSES, DOCUMENT_SOURCES, ID_PROOF_TYPES } from '@/lib/rcm/constants'
import { isUniqueViolation, pgErrorCode } from '@/lib/db-errors'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from './rcm-fixtures'

const M = '2026-10-09-sp7-c-preauth-claims.sql'
const TABLES = [preauths, preauthEvents, rcmQueries, rcmQueryResponses, preauthDocuments, claims, claimInvoices, claimSubmissions, claimDispatches, claimEvents, claimDocuments, claimDisallowances, claimSettlements, claimWriteOffs] as const
const TRIGGERS = ['claim_submissions_append_only', 'claim_events_append_only', 'claim_disallowances_append_only', 'preauth_events_append_only', 'preauth_documents_append_only', 'claim_dispatches_guard', 'claim_settlements_guard', 'claim_write_offs_guard']

describe('SP7 migration C (pre-auths and claims)', () => {
  it('migration C is idempotent and declares every column', () => {
    const s = readMigration(M); expect(idempotencyProblems(s)).toEqual([])
    for (const t of TABLES) expect(missingColumns(t, s)).toEqual([])
    for (const n of ['preauth_number_seq', 'claim_number_seq', 'sp7_append_only', 'claim_dispatches', 'claim_settlements_claim_utr_unique', 'claims_credits_le_claimed', 'claim_write_offs_second_person', 'pg_trigger', 'preauth_id']) expect(s).toContain(n)
    expect(s).toMatch(/ALTER TABLE charge_lines ADD COLUMN IF NOT EXISTS preauth_id integer;/)
    expect(s).toContain('charge_lines_preauth_id_preauths_id_fk')
    expect(s).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i)
  })
  it('every FK, unique, check, index and primary-key name is in the SQL and fits 63 chars; no ON DELETE', () => {
    const s = readMigration(M)
    for (const t of [...TABLES, chargeLines]) {
      const c = getTableConfig(t)
      const names = [
        ...c.foreignKeys.map((f) => f.getName()), ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!),
        ...c.columns.filter((col) => col.isUnique).map((col) => col.uniqueName!), ...c.primaryKeys.map((p) => p.getName()),
      ]
      for (const n of names) {
        expect(n.length, n).toBeLessThanOrEqual(63)
        if (t !== chargeLines || n.includes('preauth')) expect(s, n).toContain(n)
      }
      for (const fk of c.foreignKeys) if (t !== chargeLines) expect(fk.onDelete ?? 'no action', fk.getName()).toBe('no action')
    }
    expect(s.replace(/--[^\n]*/g, '')).not.toMatch(/ON DELETE/)
  })
  it('enums match the pure constants and the migration', () => {
    const s = readMigration(M)
    const pairs = [
      [preauthStatusEnum, PREAUTH_STATUSES], [preauthActionEnum, PREAUTH_ACTIONS], [claimStatusEnum, CLAIM_STATUSES], [claimEventActionEnum, CLAIM_EVENT_ACTIONS],
      [submissionKindEnum, SUBMISSION_KINDS], [rcmQueryStatusEnum, RCM_QUERY_STATUSES], [writeOffStatusEnum, WRITE_OFF_STATUSES], [documentSourceEnum, DOCUMENT_SOURCES],
    ] as const
    for (const [e, values] of pairs) {
      expect(e.enumValues).toEqual([...values])
      expect(s, e.enumName).toContain(`CREATE TYPE ${e.enumName} AS ENUM (${e.enumValues.map((v) => `'${v}'`).join(', ')});`)
    }
    expect([...ID_PROOF_TYPE_VALUES]).toEqual([...ID_PROOF_TYPES])
  })
  it('every amount column is bigint', () => {
    for (const t of TABLES) for (const col of getTableConfig(t).columns) if (col.name.endsWith('_paise')) expect(col.getSQLType(), `${getTableConfig(t).name}.${col.name}`).toBe('bigint')
  })
  it('every trigger is created inside a DO block that tests pg_trigger, and the purge setting is honoured', () => {
    const s = readMigration(M)
    for (const t of TRIGGERS) expect(s).toMatch(new RegExp(`tgname = '${t}'[\\s\\S]*?CREATE TRIGGER ${t} BEFORE UPDATE OR DELETE`))
    expect(s.match(/current_setting\('hims\.allow_document_purge', true\) = 'on'/g)!.length).toBe(4)
  })
})

const RUN = `${Date.now()}`.slice(-7)

describe.skipIf(!process.env.DATABASE_URL)('claims schema (DB)', () => {
  let b: RcmBase
  let claimId = 0
  let claim2Id = 0
  let submissionId = 0
  let dispatchId = 0
  let eventId = 0
  const db = () => getDb()
  const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)
  const code = async (p: Promise<unknown>) => pgErrorCode(await errorOf(p))

  beforeAll(async () => {
    b = await makeRcmBase(RUN, 'C')
    const base = { patientId: b.patientId, policyId: b.policyId, insurerPayerId: b.insurerId, tpaPayerId: b.tpaId, billingPayerId: b.tpaId, claimType: 'opd' as const, encounterId: b.encounterId, createdByName: 'Test', claimedPaise: 100_000 }
    const [c1] = await db().insert(claims).values({ ...base, claimNumber: `CLM-2099-T${RUN}1`, status: 'approved', approvedPaise: 100_000 }).returning()
    const [c2] = await db().insert(claims).values({ ...base, claimNumber: `CLM-2099-T${RUN}2`, status: 'approved', approvedPaise: 100_000 }).returning()
    claimId = c1.id; claim2Id = c2.id
    const [s] = await db().insert(claimSubmissions).values({
      claimId, version: 1, kind: 'initial', snapshot: {} as never, snapshotSha256: 'a'.repeat(64), rcmCopyBlobUrl: 'https://blob.test/r', rcmCopySha256: 'b'.repeat(64),
      insurerCopyBlobUrl: 'https://blob.test/i', insurerCopySha256: 'c'.repeat(64), createdByName: 'Test',
    }).returning()
    submissionId = s.id
    const [d] = await db().insert(claimDispatches).values({ submissionId, channel: 'portal', transport: 'manual', dispatchedOn: '2026-10-02', dispatchedByName: 'Test' }).returning()
    dispatchId = d.id
    const [e] = await db().insert(claimEvents).values({ claimId, action: 'record_settlement', fromStatus: 'approved', toStatus: 'settled', byName: 'Test' }).returning()
    eventId = e.id
  })
  afterAll(async () => {
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })

  it('refuses to update or delete a submission', async () => {
    expect(await code(db().update(claimSubmissions).set({ snapshotSha256: 'd'.repeat(64) }).where(eq(claimSubmissions.id, submissionId)))).toBe('55000')
    expect(await code(db().delete(claimSubmissions).where(eq(claimSubmissions.id, submissionId)))).toBe('55000')
    expect(await code(db().update(claimEvents).set({ note: 'x' }).where(eq(claimEvents.id, eventId)))).toBe('55000')
  })
  it('a dispatch accepts the insurer reference once', async () => {
    await db().update(claimDispatches).set({ insurerReference: 'INS/1', acknowledgedOn: '2026-10-03', acknowledgedByName: 'Test' }).where(eq(claimDispatches.id, dispatchId))
    expect(await code(db().update(claimDispatches).set({ insurerReference: 'INS/2' }).where(eq(claimDispatches.id, dispatchId)))).toBe('55000')
    expect(await code(db().delete(claimDispatches).where(eq(claimDispatches.id, dispatchId)))).toBe('55000')
  })
  it('a dispatch channel never changes, even before acknowledgement', async () => {
    const [s2] = await db().insert(claimSubmissions).values({
      claimId, version: 2, kind: 'query_response', snapshot: {} as never, snapshotSha256: 'a'.repeat(64), rcmCopyBlobUrl: 'u', rcmCopySha256: 'b'.repeat(64),
      insurerCopyBlobUrl: 'u', insurerCopySha256: 'c'.repeat(64), createdByName: 'Test',
    }).returning()
    const [d2] = await db().insert(claimDispatches).values({ submissionId: s2.id, channel: 'portal', transport: 'manual', dispatchedOn: '2026-10-02', dispatchedByName: 'Test' }).returning()
    expect(await code(db().update(claimDispatches).set({ channel: 'email' }).where(eq(claimDispatches.id, d2.id)))).toBe('55000')
    expect(isUniqueViolation(await errorOf(db().insert(claimSubmissions).values({
      claimId, version: 2, kind: 'appeal', snapshot: {} as never, snapshotSha256: 'a', rcmCopyBlobUrl: 'u', rcmCopySha256: 'b', insurerCopyBlobUrl: 'u', insurerCopySha256: 'c', createdByName: 'Test',
    })), 'claim_submissions_claim_version_unique')).toBe(true)
  })
  it('a settlement is reconciled once and its amounts never change', async () => {
    const [st] = await db().insert(claimSettlements).values({ claimId, eventId, utr: 'UTR123456', paymentDate: '2026-10-05', receivedPaise: 90_000, tdsPaise: 10_000, bankChargesPaise: 0, settledPaise: 100_000, recordedByName: 'Test' }).returning()
    expect(await code(db().update(claimSettlements).set({ receivedPaise: 1 }).where(eq(claimSettlements.id, st.id)))).toBe('55000')
    await db().update(claimSettlements).set({ bankCreditDate: '2026-10-06', reconciledAt: new Date(), reconciledByName: 'Test' }).where(eq(claimSettlements.id, st.id))
    expect(await code(db().update(claimSettlements).set({ bankCreditDate: '2026-10-07' }).where(eq(claimSettlements.id, st.id)))).toBe('55000')
    expect(await code(db().delete(claimSettlements).where(eq(claimSettlements.id, st.id)))).toBe('55000')
    expect(pgErrorCode(await errorOf(db().insert(claimSettlements).values({ claimId, eventId, utr: 'UTR999999', paymentDate: '2026-10-05', receivedPaise: 1, tdsPaise: 0, bankChargesPaise: 0, settledPaise: 2, recordedByName: 'Test' })))).toBe('23514')
  })
  it('the same UTR twice on one claim is a unique violation; on two claims it is fine', async () => {
    const v = { eventId, paymentDate: '2026-10-05', receivedPaise: 1, tdsPaise: 0, bankChargesPaise: 0, settledPaise: 1, recordedByName: 'Test' }
    expect(isUniqueViolation(await errorOf(db().insert(claimSettlements).values({ ...v, claimId, utr: 'utr123456' })), 'claim_settlements_claim_utr_unique')).toBe(true)
    await expect(db().insert(claimSettlements).values({ ...v, claimId: claim2Id, utr: 'UTR123456' })).resolves.toBeDefined()
  })
  it('settled plus written off can never pass the claimed amount', async () => {
    const err = await errorOf(db().update(claims).set({ settledPaise: 90_000, writtenOffPaise: 20_000 }).where(eq(claims.id, claim2Id)))
    expect(pgErrorCode(err)).toBe('23514')
    expect(pgErrorCode(await errorOf(db().update(claims).set({ approvedPaise: 100_001 }).where(eq(claims.id, claim2Id))))).toBe('23514')
  })
  it('a write-off is decided once, by a second person', async () => {
    const [u] = (await db().execute<{ id: number }>(sql`select id from users order by id limit 1`)).rows
    const [w] = await db().insert(claimWriteOffs).values({ claimId, amountPaise: 100, reasonCode: 'SHORTPAY', note: 'short pay', requestedByName: 'Test', requestedByUserId: u.id }).returning()
    expect(pgErrorCode(await errorOf(db().update(claimWriteOffs).set({ status: 'approved', decidedAt: new Date(), decidedByName: 'Same', decidedByUserId: u.id }).where(eq(claimWriteOffs.id, w.id))))).toBe('23514')
    await db().update(claimWriteOffs).set({ status: 'rejected', decidedAt: new Date(), decidedByName: 'Other' }).where(eq(claimWriteOffs.id, w.id))
    expect(await code(db().update(claimWriteOffs).set({ status: 'approved' }).where(eq(claimWriteOffs.id, w.id)))).toBe('55000')
    expect(await code(db().update(claimWriteOffs).set({ amountPaise: 5 }).where(eq(claimWriteOffs.id, w.id)))).toBe('55000')
  })
  it('a query has exactly one subject; a claim must match its context', async () => {
    expect(pgErrorCode(await errorOf(db().insert(rcmQueries).values({ question: 'Q', raisedOn: '2026-10-01', dueOn: '2026-10-02', createdByName: 'T' })))).toBe('23514')
    expect(pgErrorCode(await errorOf(db().insert(claims).values({ claimNumber: `CLM-2099-T${RUN}X`, patientId: b.patientId, policyId: b.policyId, insurerPayerId: b.insurerId, billingPayerId: b.insurerId, claimType: 'ipd', encounterId: b.encounterId, createdByName: 'T' })))).toBe('23514')
  })
  it('purgeRcmFixtures removes append-only fixtures', async () => {
    const extra = await makeRcmBase(RUN, 'P')
    const [c] = await db().insert(claims).values({ claimNumber: `CLM-2099-T${RUN}P`, patientId: extra.patientId, policyId: extra.policyId, insurerPayerId: extra.insurerId, billingPayerId: extra.insurerId, claimType: 'opd', encounterId: extra.encounterId, createdByName: 'T' }).returning()
    await db().insert(claimEvents).values({ claimId: c.id, action: 'note', toStatus: 'draft', byName: 'T' })
    await purgeRcmFixtures([extra.patientId], [extra.insurerId, extra.tpaId])
    expect(await db().select().from(claims).where(eq(claims.id, c.id))).toEqual([])
    await deleteRcmBasePatient(extra.patientId)
  })
})
