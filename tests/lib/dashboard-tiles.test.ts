import { describe, it, expect } from 'vitest'
import { ALL_ROLES } from '@/lib/role-policy'
import { BED_BOARD_ROLES, BOOKING_REQUEST_ROLES, hospitalTiles, snapshotScope, type HospitalSnapshot } from '@/lib/dashboard-tiles'
import { PAGE_GATES } from '../pages/page-gates-harness'
import { linkAdmits } from '../pages/dashboard-link-gates'

// Wave E P1-06/P1-07: the hospital KPI row. Pure: snapshot in, tiles out.
const FULL: HospitalSnapshot = {
  opd: { date: '2026-10-08', tokens: 42, waiting: 7, inConsultation: 3, completed: 30, cancelled: 2 },
  ipd: { admitted: 18, beds: 30, occupied: 18, available: 8, dirty: 2, blocked: 2, occupancyPct: 64, wards: [] },
  followUps: { due: 5, overdue: 4, upcoming: 9, scheduled: 3, missed: 1, capped: false },
  labs: { awaitingCollection: 6, inTransit: 2, atBench: 4, toVerify: 3, toReport: 1, criticalUnverified: 1, resultedToday: 11, criticalToday: 2, medianTatMinutes: 95 },
  collections: { date: '2026-10-08', receiptCount: 12, collectedPaise: 12345600, refundedPaise: 50000, netPaise: 12295600 },
  billing: { draftInvoices: 4, uninvoicedLines: 17, uninvoicedPaise: 2500000, pharmacyDraftCharges: 2 },
  claims: { outstandingPaise: 98765400, aging: [{ label: '0-30', paise: 1 }, { label: '91-180', paise: 300000 }, { label: '181+', paise: 200000 }], preauthsOverdue: 2, queried: 3 },
  bookingRequestsPending: 6,
}

function scoped(role: (typeof ALL_ROLES)[number]): HospitalSnapshot {
  const scope = snapshotScope(role)
  return {
    opd: FULL.opd,
    ipd: FULL.ipd,
    followUps: scope.followUps ? FULL.followUps : null,
    labs: scope.labs ? FULL.labs : null,
    collections: scope.collections ? FULL.collections : null,
    billing: scope.billing ? FULL.billing : null,
    claims: scope.claims ? FULL.claims : null,
    bookingRequestsPending: scope.bookingRequests ? FULL.bookingRequestsPending : null,
  }
}

const ids = (role: (typeof ALL_ROLES)[number]) => hospitalTiles(role, scoped(role)).map((t) => t.id)

describe('hospitalTiles', () => {
  it('the local bed-board and booking-request role lists equal those pages\' gates', () => {
    expect(new Set(BED_BOARD_ROLES)).toEqual(new Set(PAGE_GATES.find((g) => g.route === '/inpatient/beds')!.allowed))
    expect(new Set(BOOKING_REQUEST_ROLES)).toEqual(new Set(PAGE_GATES.find((g) => g.route === '/booking-requests')!.allowed))
  })

  it('admin sees the whole hospital, claim ageing included', () => {
    expect(ids('admin')).toEqual(['opd', 'inpatients', 'collections', 'billing-queue', 'follow-ups', 'labs-pending', 'lab-tat', 'booking-requests', 'claims'])
  })

  it('crc sees operations and the billing queue, never claims', () => {
    expect(ids('crc')).toEqual(['opd', 'inpatients', 'collections', 'billing-queue', 'follow-ups', 'labs-pending', 'lab-tat', 'booking-requests'])
  })

  it('frontdesk sees OPD, beds, the cash desk, recalls and booking requests -- no labs, billing or claims', () => {
    expect(ids('frontdesk')).toEqual(['opd', 'inpatients', 'collections', 'follow-ups', 'booking-requests'])
  })

  it('a role outside the hospital overview gets no tiles (its own home has its own KPIs)', () => {
    for (const role of ['pharmacy', 'billing', 'labs', 'coder', 'collector', 'rcm'] as const) expect(ids(role)).toEqual([])
  })

  it('every tile links to a page the role can open (no dead links)', () => {
    for (const role of ALL_ROLES) {
      for (const t of hospitalTiles(role, FULL)) expect.soft(linkAdmits(t.href, role), `${role} -> ${t.href}`).toBe(true)
    }
  })

  it('a snapshot section the role may not see never produces a tile, even if present', () => {
    expect(hospitalTiles('frontdesk', FULL).map((t) => t.id)).not.toContain('claims')
    expect(hospitalTiles('frontdesk', FULL).map((t) => t.id)).not.toContain('labs-pending')
  })

  it('values: rupees from paise, occupancy, overdue first in the follow-up subline, TAT in minutes', () => {
    const byId = Object.fromEntries(hospitalTiles('admin', FULL).map((t) => [t.id, t]))
    expect(byId.opd).toMatchObject({ value: 42, sub: '7 waiting · 3 in consultation', href: '/encounters' })
    expect(byId.inpatients).toMatchObject({ value: 18, sub: '64% occupied · 8 beds free', href: '/inpatient/beds' })
    expect(byId.collections).toMatchObject({ value: '₹1,22,956.00', sub: '12 receipts · ₹500.00 refunded', href: '/cash-desk' })
    expect(byId['billing-queue']).toMatchObject({ value: 4, sub: '17 lines not invoiced (₹25,000.00)', href: '/billing/invoices?status=draft' })
    expect(byId['follow-ups']).toMatchObject({ value: 9, sub: '4 overdue · 5 due', href: '/front-desk/follow-ups?bucket=overdue' })
    expect(byId['labs-pending']).toMatchObject({ value: 12, sub: '1 critical to verify', href: '/labs', tone: 'danger' })
    expect(byId['lab-tat']).toMatchObject({ value: '1 h 35 min', sub: '11 results today' })
    expect(byId['booking-requests']).toMatchObject({ value: 6, href: '/booking-requests' })
    expect(byId.claims).toMatchObject({ value: '₹9,87,654.00', sub: '₹5,000.00 over 90 days', href: '/rcm' })
  })

  it('follow-ups link to the due bucket when nothing is overdue', () => {
    const t = hospitalTiles('frontdesk', { ...scoped('frontdesk'), followUps: { ...FULL.followUps!, overdue: 0 } }).find((x) => x.id === 'follow-ups')
    expect(t).toMatchObject({ value: 5, href: '/front-desk/follow-ups?bucket=due' })
  })
})
