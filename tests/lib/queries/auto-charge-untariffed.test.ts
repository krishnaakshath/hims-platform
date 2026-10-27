// WS2 T14 (ruling on T8): the bill-to of an automatic line priced outside the tariff (pharmacy).
// Same rule as captureAutoChargeInTx: autoBillTo, with the pre-auth-only fallback to self-pay.
// Runs against the worktree's isolated test DB; every row is a TEST fixture removed afterwards.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, chargeRuleConfigs, encounters, patients, payers, providers } from '@/db/schema'
import { untariffedAutoBillToInTx } from '@/lib/queries/auto-charge'

const TAG = `TWS2T14U-${Date.now()}`
const IPD = `${TAG}-I`
const OPD = `${TAG}-O`
let payerId = 0
let admissionId = 0
let encounterId = 0
// The rule config is global: the run's own preauth_required row (if any) is set aside and restored.
let savedConfig: (typeof chargeRuleConfigs.$inferSelect) | undefined

const decide = (ref: Parameters<typeof untariffedAutoBillToInTx>[1], requiresPreauth: boolean) =>
  getDb().transaction((tx) => untariffedAutoBillToInTx(tx, ref, { requiresPreauth }))

beforeAll(async () => {
  const db = getDb()
  const [prov] = await db.select({ id: providers.id }).from(providers).where(eq(providers.isActive, true)).limit(1)
  const [p] = await db.insert(payers).values({ name: `${TAG} Insurer`, payerId: `${TAG}-P`, requiresPreauth: true }).returning()
  payerId = p.id
  await db.insert(patients).values([IPD, OPD].map((id) => ({ id, name: `TEST_WS2T14 ${id.slice(-1)}`, dob: '1990-01-01', primaryPayerId: payerId })))
  const [a] = await db.insert(admissions).values({ patientId: IPD, attendingProviderId: prov.id, admittedAt: new Date('2026-10-18T06:00:00Z') }).returning()
  admissionId = a.id
  const [e] = await db.insert(encounters).values({ patientId: OPD, encounterType: 'opd', status: 'in_consultation', encounterDate: '2026-10-20', providerId: prov.id, checkedInByName: 'TEST_WS2T14' }).returning()
  encounterId = e.id
  ;[savedConfig] = await db.select().from(chargeRuleConfigs).where(eq(chargeRuleConfigs.ruleCode, 'preauth_required'))
  await db.delete(chargeRuleConfigs).where(eq(chargeRuleConfigs.ruleCode, 'preauth_required'))
})

afterEach(async () => {
  await getDb().delete(chargeRuleConfigs).where(eq(chargeRuleConfigs.ruleCode, 'preauth_required'))
})

afterAll(async () => {
  const db = getDb()
  await db.delete(encounters).where(inArray(encounters.patientId, [IPD, OPD]))
  await db.delete(admissions).where(inArray(admissions.patientId, [IPD, OPD]))
  await db.delete(patients).where(inArray(patients.id, [IPD, OPD]))
  await db.delete(payers).where(eq(payers.id, payerId))
  if (savedConfig) await db.insert(chargeRuleConfigs).values(savedConfig)
})

describe('untariffedAutoBillToInTx', () => {
  it('a line in an admission bills the primary payer', async () => {
    expect(await decide({ admissionId }, false)).toEqual({ payerId, fellBack: null })
  })

  it('an OPD visit line and a line with no visit or stay are self-pay', async () => {
    expect(await decide({ encounterId }, false)).toEqual({ payerId: null, fellBack: null })
    expect(await decide(null, false)).toEqual({ payerId: null, fellBack: null })
  })

  it('falls back to self-pay when the payer and the item both need pre-authorisation', async () => {
    expect(await decide({ admissionId }, true)).toEqual({ payerId: null, fellBack: ['preauth_required'] })
  })

  it('no fallback when the rule config disables preauth_required or makes it a warning', async () => {
    const db = getDb()
    await db.insert(chargeRuleConfigs).values({ ruleCode: 'preauth_required', enabled: false, updatedByName: 'TEST_WS2T14' })
    expect(await decide({ admissionId }, true)).toEqual({ payerId, fellBack: null })
    await db.update(chargeRuleConfigs).set({ enabled: true, severity: 'warn' }).where(eq(chargeRuleConfigs.ruleCode, 'preauth_required'))
    expect(await decide({ admissionId }, true)).toEqual({ payerId, fellBack: null })
  })
})
