import { describe, it, expect } from 'vitest'
import {
  FEED_SOURCES, feedSourcesFor, mergeFeed, sourceHref, userKeyFor, withReadState, NOTIFICATION_KEY_RE,
  showsPatientNames, type StaffNotification,
} from '@/lib/notifications/staff-feed'
import { ALL_ROLES } from '@/lib/role-policy'
import { NAV_ITEMS, NAV_TRAILING_ITEMS, NAV_BILLING_ITEMS, BILLING_ROLES } from '@/components/LeftNav'
import type { Role } from '@/lib/auth'

const n = (key: string, occurredAt: string): StaffNotification => ({ key, kind: 'lab_report', title: 't', detail: 'd', href: '/labs', occurredAt, severity: 'info' })

function navHrefsFor(role: Role): string[] {
  const visible = (i: { roles?: Role[] }) => !i.roles || i.roles.includes(role)
  const hrefs = [...NAV_ITEMS.filter(visible), ...NAV_TRAILING_ITEMS.filter(visible)].map((i) => i.href)
  if (BILLING_ROLES.includes(role)) hrefs.push(...NAV_BILLING_ITEMS.map((i) => i.href))
  return hrefs
}

// Wave G P2-01
describe('feedSourcesFor', () => {
  it('matches the decision table', () => {
    expect(feedSourcesFor('admin')).toEqual(['lab_critical', 'lab_report', 'follow_up_due', 'booking_request', 'assignment_declined', 'low_stock', 'notice_failed'])
    expect(feedSourcesFor('pi')).toEqual(['lab_critical', 'lab_report', 'booking_request', 'assignment_pending'])
    expect(feedSourcesFor('crc')).toEqual(['lab_critical', 'lab_report', 'follow_up_due', 'booking_request', 'assignment_declined', 'notice_failed'])
    expect(feedSourcesFor('frontdesk')).toEqual(['follow_up_due', 'booking_request', 'assignment_declined', 'notice_failed'])
    expect(feedSourcesFor('pharmacy')).toEqual(['low_stock'])
    expect(feedSourcesFor('labs')).toEqual(['lab_critical', 'lab_receipt'])
    expect(feedSourcesFor('billing')).toEqual(['charges_uninvoiced'])
    expect(feedSourcesFor('coder')).toEqual(['coding_queue'])
    expect(feedSourcesFor('collector')).toEqual(['home_visit'])
  })

  it('every item a role can get links to a page that role can open (nav == gate)', () => {
    for (const role of ALL_ROLES) {
      const nav = navHrefsFor(role)
      for (const source of feedSourcesFor(role)) {
        for (const pid of [null, 'RD-0001']) {
          const href = sourceHref(source, role, pid)
          if (href.startsWith('/patients/')) {
            expect(showsPatientNames(role), `${role} ${source}`).toBe(true)
            expect(nav, `${role} ${source}`).toContain('/patients')
          } else {
            expect(nav, `${role} ${source} -> ${href}`).toContain(href)
          }
        }
      }
    }
  })

  it('covers every source with at least one role', () => {
    for (const s of FEED_SOURCES) expect(ALL_ROLES.some((r) => feedSourcesFor(r).includes(s)), s).toBe(true)
  })
})

describe('feed helpers', () => {
  it('merges newest first, de-duplicates by key and caps', () => {
    const merged = mergeFeed([[n('a:1', '2026-10-08T01:00:00.000Z'), n('b:1', '2026-10-08T03:00:00.000Z')], [n('a:1', '2026-10-08T01:00:00.000Z'), n('c:1', '2026-10-08T02:00:00.000Z')]], 2)
    expect(merged.map((m) => m.key)).toEqual(['b:1', 'c:1'])
  })

  it('counts unread against the stored read keys', () => {
    const feed = withReadState([n('a:1', '2026-10-08T01:00:00.000Z'), n('b:1', '2026-10-08T02:00:00.000Z')], new Set(['a:1']))
    expect(feed.unreadCount).toBe(1)
    expect(feed.items.map((i) => i.read)).toEqual([true, false])
  })

  it('keys the read state by user id, or role and name when the session has none', () => {
    expect(userKeyFor({ role: 'pi', name: 'Dr A', userId: 12 })).toBe('u:12')
    expect(userKeyFor({ role: 'admin', name: 'Admin', userId: null })).toBe('n:admin:Admin')
  })

  it('accepts only well-formed item keys', () => {
    for (const k of ['lab_report:12', 'follow_up_due:2026-10-08', 'low_stock:4:1759900000']) expect(NOTIFICATION_KEY_RE.test(k), k).toBe(true)
    for (const k of ['', 'x', 'lab_report:', "lab_report:1'; drop", 'LAB:1', `lab_report:${'1'.repeat(65)}`]) expect(NOTIFICATION_KEY_RE.test(k), k).toBe(false)
  })
})
