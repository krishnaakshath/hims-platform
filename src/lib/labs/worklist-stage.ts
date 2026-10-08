// Wave E P1-15: the lab worklist's stage sections as URL slugs, so a labs-home
// tile (and the doctor's "Verify" link) can open the worklist filtered to one
// stage. Pure and client-safe.
import type { LabOrderStatus } from '@/lib/labs/status'

export const LAB_STAGES = ['to-collect', 'in-transit', 'at-bench', 'to-verify', 'to-report', 'reported'] as const
export type LabStage = (typeof LAB_STAGES)[number]

/** The order statuses each worklist section lists (LabWorklist renders the same split). */
export const LAB_STAGE_STATUSES: Record<LabStage, readonly LabOrderStatus[]> = {
  'to-collect': ['ordered', 'scheduled'],
  'in-transit': ['collected'],
  'at-bench': ['received'],
  'to-verify': ['resulted'],
  'to-report': ['verified'],
  reported: ['reported'],
}

/** `?stage=` value: a stage slug, 'all' (worklist tab, unfiltered), or null (ignored). */
export function parseLabStage(v: string | string[] | undefined): LabStage | 'all' | null {
  const s = Array.isArray(v) ? v[0] : v
  if (s === 'all') return 'all'
  return (LAB_STAGES as readonly string[]).includes(s ?? '') ? (s as LabStage) : null
}
