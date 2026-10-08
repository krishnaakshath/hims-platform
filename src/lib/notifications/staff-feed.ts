// Wave G P2-01: the staff notification feed -- pure, client-safe parts. The feed is
// computed from live events (src/lib/queries/staff-notifications.ts); nothing here is
// simulated. Which sources a role gets is decided ONLY by feedSourcesFor, and every
// source's link is a page that role's gate admits (pinned by tests/lib/notifications).
//
// PHI rule: an item carries at most a patient's name and UHID, and only for
// PATIENT_DIRECTORY_ROLES; never a phone number, never a result value, never an
// Aadhaar/ABHA number.
import type { Role } from '@/lib/auth'
import {
  CLINICAL_ROLES, CODING_ROLES, CHARGE_CAPTURE_ROLES, COLLECTOR_ROUTE_ROLES, FOLLOW_UP_WORKLIST_ROLES,
  LAB_WORKLIST_ROLES, NOTIFICATION_PREFERENCE_ROLES, PATIENT_DIRECTORY_ROLES,
} from '@/lib/role-policy'

export type NotificationSeverity = 'info' | 'warning' | 'critical'

export interface StaffNotification {
  /** Stable id: `<kind>:<ref>`; the read state is stored against it. */
  key: string
  kind: FeedSource
  title: string
  detail: string
  href: string
  /** ISO instant. */
  occurredAt: string
  severity: NotificationSeverity
}

export interface StaffNotificationView extends StaffNotification { read: boolean }
export interface StaffFeed { items: StaffNotificationView[]; unreadCount: number }

export const FEED_SOURCES = [
  'lab_critical', 'lab_report', 'follow_up_due', 'booking_request', 'assignment_declined',
  'assignment_pending', 'low_stock', 'notice_failed', 'home_visit', 'lab_receipt', 'coding_queue',
  'charges_uninvoiced',
] as const
export type FeedSource = (typeof FEED_SOURCES)[number]

// Roles per source. Each list is (a subset of) the gate of the page the item links to.
const BOOKING_REQUEST_PAGE_ROLES: readonly Role[] = ['frontdesk', 'admin', 'crc', 'pi'] // LeftNav /booking-requests
const ASSIGNMENTS_PAGE_ROLES: readonly Role[] = ['frontdesk', 'admin', 'crc'] // LeftNav /front-desk/assignments
const STOCK_ROLES: readonly Role[] = ['admin', 'pharmacy'] // /pharmacy (the counter that restocks)
export const FEED_SOURCE_ROLES: Record<FeedSource, readonly Role[]> = {
  lab_critical: LAB_WORKLIST_ROLES,
  // labs releases reports itself; the doctors and coordinators are the audience.
  lab_report: CLINICAL_ROLES,
  follow_up_due: FOLLOW_UP_WORKLIST_ROLES,
  booking_request: BOOKING_REQUEST_PAGE_ROLES,
  assignment_declined: ASSIGNMENTS_PAGE_ROLES,
  // "assigned to you": only a doctor has a personal queue (/doctor).
  assignment_pending: ['pi'],
  low_stock: STOCK_ROLES,
  notice_failed: NOTIFICATION_PREFERENCE_ROLES,
  // "assigned to you": the collector's own route (admin sees every route on /collections already).
  home_visit: COLLECTOR_ROUTE_ROLES.filter((r) => r !== 'admin'),
  lab_receipt: ['labs'],
  coding_queue: CODING_ROLES.filter((r) => r !== 'admin'),
  charges_uninvoiced: CHARGE_CAPTURE_ROLES.filter((r) => r === 'billing'),
}

export function feedSourcesFor(role: Role): FeedSource[] {
  return FEED_SOURCES.filter((s) => FEED_SOURCE_ROLES[s].includes(role))
}

const SOURCE_PAGE: Record<FeedSource, string> = {
  lab_critical: '/labs',
  lab_report: '/labs',
  follow_up_due: '/front-desk/follow-ups',
  booking_request: '/booking-requests',
  assignment_declined: '/front-desk/assignments',
  assignment_pending: '/doctor',
  low_stock: '/pharmacy',
  notice_failed: '/patients',
  home_visit: '/collections',
  lab_receipt: '/labs',
  coding_queue: '/coding',
  charges_uninvoiced: '/billing/invoices',
}

/** Where an item leads: the patient's page when it is about one patient and the role
 *  has the patient directory, else the source's worklist page. */
export function sourceHref(source: FeedSource, role: Role, patientId?: string | null): string {
  if (patientId && PATIENT_DIRECTORY_ROLES.includes(role)) return `/patients/${encodeURIComponent(patientId)}`
  return SOURCE_PAGE[source]
}

/** May this role see a patient's name / UHID in an item (else a neutral reference)? */
export function showsPatientNames(role: Role): boolean {
  return PATIENT_DIRECTORY_ROLES.includes(role)
}

export const FEED_LIMIT = 30
export const FEED_SOURCE_LIMIT = 10
/** Event lookback for one-off events (results, reports, requests). */
export const FEED_LOOKBACK_DAYS = 14
/** Read rows older than this are pruned (well past every lookback). */
export const READ_RETENTION_DAYS = 45

export const NOTIFICATION_KEY_RE = /^[a-z_]{3,32}:[A-Za-z0-9:_-]{1,64}$/

/** The per-user key the read state is stored under. */
export function userKeyFor(session: { role: Role; name: string; userId: number | null }): string {
  return session.userId !== null ? `u:${session.userId}` : `n:${session.role}:${session.name}`.slice(0, 200)
}

/** Newest first, de-duplicated by key, capped. */
export function mergeFeed(groups: StaffNotification[][], limit = FEED_LIMIT): StaffNotification[] {
  const seen = new Set<string>()
  const all: StaffNotification[] = []
  for (const g of groups) for (const n of g) if (!seen.has(n.key)) { seen.add(n.key); all.push(n) }
  all.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : a.key.localeCompare(b.key, 'en-IN')))
  return all.slice(0, limit)
}

export function withReadState(items: StaffNotification[], readKeys: ReadonlySet<string>): StaffFeed {
  const views = items.map((n) => ({ ...n, read: readKeys.has(n.key) }))
  return { items: views, unreadCount: views.filter((v) => !v.read).length }
}
