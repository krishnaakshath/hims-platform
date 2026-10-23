// WS8 T15: the "Needs attention" strip on each role's home dashboard. A handful of counts of work
// that is late or waiting on someone, each linking to the page that lists it.
//
// - A role sees an item only when it may open the item's page: each source carries the same role
//   list that page gates on, so a count is never offered that the role cannot drill into (and no
//   query runs for a role that may not see it).
// - Only counts above zero are shown, danger first, at most MAX_ATTENTION_ITEMS.
// - A source whose stream has not merged yet is skipped by a feature check on what its module
//   returns (e.g. PharmacyKpi without `expiringIn90Days` before the batch-stock work lands), never
//   by catching SQL errors.
// Counts only: no names, UHIDs, UTRs or credential numbers pass through here.
import type { Role } from '@/lib/auth'
import {
  CASH_DESK_ROLES, CLINICAL_ROLES, FOLLOW_UP_WORKLIST_ROLES, LAB_WORKLIST_ROLES, PORTAL_SUBMISSION_REVIEW_ROLES, RCM_ROLES,
} from '@/lib/role-policy'
import { getFollowUpBuckets, getLabKpis, getPharmacyKpis } from '@/lib/queries/hospital-kpis'
import { countCredentialsExpiringWithin } from '@/lib/queries/staff-credentials'
import { countPoliciesExpiringBetween } from '@/lib/queries/rcm-policies'
import { EXPIRING_DAYS } from '@/lib/queries/coverage-attention'
import { countPendingPortalSubmissions } from '@/lib/queries/portal-submissions'
import { countOverdueDataPrincipalRequests } from '@/lib/queries/data-principal-requests'
import { countReportedPortalUpiRequests } from '@/lib/payments/manual-upi'

export type AttentionId =
  | 'critical_labs' | 'overdue_follow_ups' | 'expiring_credentials' | 'expiring_policies' | 'low_stock' | 'expiring_stock'
  | 'pending_portal_submissions' | 'reported_upi' | 'overdue_data_requests'

export interface AttentionItem { id: AttentionId; label: string; count: number; href: string; tone: 'danger' | 'warning' }

export const MAX_ATTENTION_ITEMS = 6
export const CREDENTIAL_WINDOW_DAYS = 30

// Gates of pages with no named role-policy constant (pharmacy/page.tsx, governance/data-requests/page.tsx);
// tests/lib/queries/needs-attention.test.ts checks them against PAGE_GATES.
export const PHARMACY_DASHBOARD_ROLES: readonly Role[] = ['crc', 'pi', 'admin', 'pharmacy']
export const DATA_REQUEST_REGISTER_ROLES: readonly Role[] = ['admin']

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many)

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

type Found = Omit<AttentionItem, 'id'> | null

/** Loads shared by several sources run once per strip. */
function context(todayIso: string) {
  let pharmacy: ReturnType<typeof getPharmacyKpis> | null = null
  return { todayIso, pharmacy: () => (pharmacy ??= getPharmacyKpis(todayIso)) }
}
type Ctx = ReturnType<typeof context>

interface AttentionSource { id: AttentionId; roles: readonly Role[]; load: (ctx: Ctx) => Promise<Found> }

export const ATTENTION_SOURCES: readonly AttentionSource[] = [
  {
    id: 'critical_labs', roles: LAB_WORKLIST_ROLES,
    load: async ({ todayIso }) => {
      const count = (await getLabKpis(todayIso)).criticalUnverified
      return { count, label: `Critical lab ${plural(count, 'result')} to verify`, href: '/labs?stage=to-verify', tone: 'danger' }
    },
  },
  {
    id: 'overdue_data_requests', roles: DATA_REQUEST_REGISTER_ROLES,
    load: async ({ todayIso }) => {
      const count = await countOverdueDataPrincipalRequests(todayIso)
      return { count, label: `Data ${plural(count, 'request')} past the due date`, href: '/governance/data-requests', tone: 'danger' }
    },
  },
  {
    id: 'expiring_credentials', roles: CLINICAL_ROLES,
    load: async ({ todayIso }) => {
      const { expired, expiring } = await countCredentialsExpiringWithin(todayIso, CREDENTIAL_WINDOW_DAYS)
      const count = expired + expiring
      return {
        count, label: `Staff ${plural(count, 'credential')} expired or expiring in ${CREDENTIAL_WINDOW_DAYS} days`, href: '/staff',
        tone: expired > 0 ? 'danger' : 'warning',
      }
    },
  },
  {
    id: 'low_stock', roles: PHARMACY_DASHBOARD_ROLES,
    load: async (ctx) => {
      const { outOfStock, lowStock } = await ctx.pharmacy()
      const count = outOfStock + lowStock
      return {
        count, label: `${plural(count, 'Medicine')} out of stock or low`, href: `/pharmacy?stock=${outOfStock > 0 ? 'out' : 'low'}`,
        tone: outOfStock > 0 ? 'danger' : 'warning',
      }
    },
  },
  {
    // Batch expiry belongs to the pharmacy stock stream: until PharmacyKpi carries
    // `expiringIn90Days` (and /pharmacy accepts ?stock=expiring) this item does not exist.
    id: 'expiring_stock', roles: PHARMACY_DASHBOARD_ROLES,
    load: async (ctx) => {
      const kpis = await ctx.pharmacy()
      if (!('expiringIn90Days' in kpis)) return null
      const count = Number(kpis.expiringIn90Days)
      return { count, label: `${plural(count, 'Medicine')} with stock expiring in 90 days`, href: '/pharmacy?stock=expiring', tone: 'warning' }
    },
  },
  {
    id: 'overdue_follow_ups', roles: FOLLOW_UP_WORKLIST_ROLES,
    load: async ({ todayIso }) => {
      const count = (await getFollowUpBuckets(null, todayIso)).overdue
      return { count, label: `Overdue ${plural(count, 'follow-up')} to recall`, href: '/front-desk/follow-ups?bucket=overdue', tone: 'warning' }
    },
  },
  {
    id: 'reported_upi', roles: CASH_DESK_ROLES,
    load: async () => {
      const count = await countReportedPortalUpiRequests()
      return { count, label: `Portal UPI ${plural(count, 'payment')} to confirm`, href: '/cash-desk', tone: 'warning' }
    },
  },
  {
    id: 'pending_portal_submissions', roles: PORTAL_SUBMISSION_REVIEW_ROLES,
    load: async () => {
      const count = await countPendingPortalSubmissions()
      return { count, label: `Portal ${plural(count, 'submission')} to review`, href: '/front-desk/portal-submissions', tone: 'warning' }
    },
  },
  {
    id: 'expiring_policies', roles: RCM_ROLES,
    load: async ({ todayIso }) => {
      const count = await countPoliciesExpiringBetween(todayIso, addDaysIso(todayIso, EXPIRING_DAYS))
      return { count, label: `Insurance ${plural(count, 'policy', 'policies')} expiring in ${EXPIRING_DAYS} days`, href: `/rcm/policies?expiring=${EXPIRING_DAYS}`, tone: 'warning' }
    },
  },
]

/** Non-zero items only, danger before warning (source order otherwise), at most MAX_ATTENTION_ITEMS. */
export function rankAttention(items: AttentionItem[]): AttentionItem[] {
  const shown = items.filter((i) => i.count > 0)
  return [...shown.filter((i) => i.tone === 'danger'), ...shown.filter((i) => i.tone === 'warning')].slice(0, MAX_ATTENTION_ITEMS)
}

export async function loadNeedsAttention(role: Role, todayIso: string): Promise<AttentionItem[]> {
  const ctx = context(todayIso)
  const found = await Promise.all(
    ATTENTION_SOURCES.filter((s) => s.roles.includes(role)).map(async (s) => {
      const item = await s.load(ctx)
      return item ? { id: s.id, ...item } : null
    }),
  )
  return rankAttention(found.filter((i): i is AttentionItem => i !== null))
}
