// SP4: billing settings (singleton), charge-rule configuration and payer billing flags.
// Every write runs in one transaction with its audit row.
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { billingSettings, chargeRuleConfigs, payers, serviceCatalog, type BillingSettingsRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import {
  CHARGE_RULES, CHARGE_RULE_CODES, type ChargeRuleCode, type ChargeRuleDefinition, type RuleConfig, type RuleConfigEntry, type RuleSeverity,
} from '@/lib/billing/charge-rules'
import type { BillingSettingsInput } from '@/lib/billing/validation'
import type { WriteExecutor } from './executor'

/** The migration-A defaults, used when the singleton row is missing (a DB before migration A). */
const DEFAULT_SETTINGS: BillingSettingsRow = {
  id: 1, legalName: null, gstin: null, stateCode: null, address: null, placeOfSupplyMode: 'location_of_service',
  consultationWindowDays: 30, ipdDepositThresholdPaise: 0, roomRentServiceId: null, pharmacyGstRateBp: 500, pharmacyHsn: '3004',
  updatedAt: new Date(0), updatedByName: null,
  rohiniId: null, hfrId: null, // SP7
}

export async function getBillingSettings(executor: WriteExecutor = getDb()): Promise<BillingSettingsRow> {
  const [row] = await executor.select().from(billingSettings).where(eq(billingSettings.id, 1)).limit(1)
  return row ?? { ...DEFAULT_SETTINGS }
}

const SETTING_KEYS = [
  'legalName', 'gstin', 'stateCode', 'address', 'placeOfSupplyMode', 'consultationWindowDays', 'ipdDepositThresholdPaise',
  'roomRentServiceId', 'pharmacyGstRateBp', 'pharmacyHsn',
] as const satisfies readonly (keyof BillingSettingsInput & keyof BillingSettingsRow)[]

export async function updateBillingSettings(
  input: BillingSettingsInput, session: Session,
): Promise<{ ok: true } | { ok: false; error: 'room_rent_service_invalid' }> {
  return getDb().transaction(async (tx) => {
    if (input.roomRentServiceId !== null) {
      const [svc] = await tx.select({ category: serviceCatalog.category }).from(serviceCatalog).where(eq(serviceCatalog.id, input.roomRentServiceId)).limit(1)
      if (!svc || svc.category !== 'room_rent') return { ok: false as const, error: 'room_rent_service_invalid' as const }
    }
    const [current] = await tx.select().from(billingSettings).where(eq(billingSettings.id, 1)).for('update')
    const before = current ?? DEFAULT_SETTINGS
    const changed = SETTING_KEYS.filter((k) => before[k] !== input[k]).sort()
    const values = { ...input, updatedAt: new Date(), updatedByName: session.name }
    await tx.insert(billingSettings).values({ id: 1, ...values }).onConflictDoUpdate({ target: billingSettings.id, set: values })
    await logAudit(session, 'billing: updated billing settings', null, `fields=${changed.join(',')}`, tx)
    return { ok: true as const }
  })
}

export async function getRuleConfig(executor: WriteExecutor = getDb()): Promise<RuleConfig> {
  const rows = await executor.select().from(chargeRuleConfigs)
  const known = new Set<string>(CHARGE_RULE_CODES)
  const out: RuleConfig = {}
  for (const r of rows) {
    if (known.has(r.ruleCode)) out[r.ruleCode as ChargeRuleCode] = { enabled: r.enabled, severity: r.severity ?? null }
  }
  return out
}

export async function setRuleConfig(
  code: ChargeRuleCode, entry: RuleConfigEntry, session: Session,
): Promise<{ ok: true } | { ok: false; error: 'not_configurable' }> {
  const def = CHARGE_RULES.find((r) => r.code === code)
  if (!def || !def.configurable) return { ok: false, error: 'not_configurable' }
  await getDb().transaction(async (tx) => {
    const values = { enabled: entry.enabled, severity: entry.severity, updatedAt: new Date(), updatedByName: session.name }
    await tx.insert(chargeRuleConfigs).values({ ruleCode: code, ...values }).onConflictDoUpdate({ target: chargeRuleConfigs.ruleCode, set: values })
    await logAudit(session, 'billing: updated charge rule', null,
      `rule=${code} enabled=${entry.enabled} severity=${entry.severity ?? 'default'}`, tx)
  })
  return { ok: true }
}

export type RuleRow = ChargeRuleDefinition & RuleConfigEntry & { effectiveSeverity: RuleSeverity }

/** The rule table merged with this hospital's configuration, in table order. */
export async function listRuleRows(): Promise<RuleRow[]> {
  const config = await getRuleConfig()
  return CHARGE_RULES.map((def) => {
    const entry = def.configurable ? config[def.code] : undefined
    const severity = entry?.severity ?? null
    return { ...def, enabled: entry?.enabled ?? true, severity, effectiveSeverity: severity ?? def.defaultSeverity }
  })
}

export interface PayerBillingFlagsInput { requiresPreauth: boolean; gstin: string | null; stateCode: string | null }

/** False when the payer does not exist. Audit details carry the payer id only. */
export async function updatePayerBillingFlags(payerId: number, input: PayerBillingFlagsInput, session: Session): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx.update(payers)
      .set({ requiresPreauth: input.requiresPreauth, gstin: input.gstin, stateCode: input.stateCode })
      .where(eq(payers.id, payerId)).returning({ id: payers.id })
    if (!row) return false
    await logAudit(session, 'billing: updated payer billing flags', null, `payer=${payerId}`, tx)
    return true
  })
}
