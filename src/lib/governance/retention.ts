// WS8 T14 (spec D18): the hospital's record-retention schedule. These periods are DEFAULTS chosen
// for the software, pending review by the hospital's legal counsel; they are shown on the Data
// requests page with that label. They decide whether a DPDP erasure request can delete a chart or
// must instead archive it and scrub contact fields (financial and medico-legal records are never
// deleted).

export type RetentionCategory = 'medical_records' | 'mlc_records' | 'financial_records' | 'audit_log' | 'notification_log' | 'portal_uploads'

export interface RetentionRule {
  category: RetentionCategory
  label: string
  years: number
  basis: string
  status: 'default_pending_legal_review'
}

export const RETENTION_SCHEDULE: readonly RetentionRule[] = [
  { category: 'medical_records', label: 'Medical records', years: 3, basis: 'From the last visit or discharge; the common minimum for outpatient and inpatient records', status: 'default_pending_legal_review' },
  { category: 'mlc_records', label: 'Medico-legal case records', years: 10, basis: 'From the last visit; medico-legal records may be needed by a court or the police', status: 'default_pending_legal_review' },
  { category: 'financial_records', label: 'Bills, receipts, refunds and insurance claims', years: 8, basis: 'Books of account and GST records', status: 'default_pending_legal_review' },
  { category: 'audit_log', label: 'Audit log', years: 8, basis: 'Kept as long as the financial records it explains', status: 'default_pending_legal_review' },
  { category: 'notification_log', label: 'Notification log', years: 2, basis: 'Delivery evidence for messages sent to patients', status: 'default_pending_legal_review' },
  { category: 'portal_uploads', label: 'Patient portal uploads', years: 3, basis: 'Same as the medical records they support', status: 'default_pending_legal_review' },
] as const

export const RETENTION_STATUS_LABEL = 'Default, pending legal review'

export function retentionYears(category: RetentionCategory): number {
  const rule = RETENTION_SCHEDULE.find((r) => r.category === category)
  if (!rule) throw new Error(`Unknown retention category: ${category}`)
  return rule.years
}

/** `dateIso` (YYYY-MM-DD) plus `years` calendar years, as YYYY-MM-DD (29 Feb rolls to 1 Mar). */
function addYears(dateIso: string, years: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`)
  d.setUTCFullYear(d.getUTCFullYear() + years)
  return d.toISOString().slice(0, 10)
}

/**
 * The reasons a chart must be kept (archived and scrubbed) instead of deleted, or [] when nothing
 * retained applies. `todayIso` and `lastEncounterDate` are YYYY-MM-DD (IST).
 */
export function retentionBlocksErasure(facts: { hasFinancial: boolean; hasMlc: boolean; lastEncounterDate: string | null }, todayIso: string): string[] {
  const reasons: string[] = []
  if (facts.hasFinancial) {
    reasons.push(`Bills, receipts or insurance records exist; they are kept for ${retentionYears('financial_records')} years.`)
  }
  if (facts.hasMlc) {
    reasons.push(`The chart is a medico-legal case; its records are kept for ${retentionYears('mlc_records')} years.`)
  }
  if (facts.lastEncounterDate) {
    const keepUntil = addYears(facts.lastEncounterDate, retentionYears('medical_records'))
    if (keepUntil > todayIso) {
      reasons.push(`The last visit was on ${facts.lastEncounterDate}; medical records are kept for ${retentionYears('medical_records')} years, until ${keepUntil}.`)
    }
  }
  return reasons
}
