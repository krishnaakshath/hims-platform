import type { HospitalSnapshot } from '@/lib/dashboard-tiles'

// Wave E: a hospital KPI snapshot for dashboard render tests. Numbers are
// chosen not to collide with the figures older dashboard tests look for.
export const HOSPITAL_SNAPSHOT: HospitalSnapshot = {
  opd: { date: '2026-10-08', tokens: 42, waiting: 7, inConsultation: 3, completed: 30, cancelled: 2 },
  ipd: {
    admitted: 18, beds: 30, occupied: 18, available: 8, dirty: 2, blocked: 2, occupancyPct: 64,
    wards: [
      { ward: 'General Ward', beds: 20, occupied: 12, available: 6, dirty: 1, blocked: 1, occupancyPct: 63 },
      { ward: 'ICU', beds: 10, occupied: 6, available: 2, dirty: 1, blocked: 1, occupancyPct: 67 },
    ],
  },
  followUps: { due: 5, overdue: 4, upcoming: 9, scheduled: 3, missed: 1, capped: false },
  labs: { awaitingCollection: 6, inTransit: 2, atBench: 4, toVerify: 3, toReport: 1, criticalUnverified: 1, resultedToday: 11, criticalToday: 2, medianTatMinutes: 95 },
  collections: { date: '2026-10-08', receiptCount: 12, collectedPaise: 12345600, refundedPaise: 50000, netPaise: 12295600 },
  billing: { draftInvoices: 4, uninvoicedLines: 17, uninvoicedPaise: 2500000, pharmacyDraftCharges: 2, pendingApprovalCharges: 3 },
  claims: { outstandingPaise: 98765400, aging: [{ label: '0-30', paise: 100000 }, { label: '31-60', paise: 0 }, { label: '61-90', paise: 0 }, { label: '91-180', paise: 300000 }, { label: '181+', paise: 200000 }], preauthsOverdue: 2, queried: 3 },
  bookingRequestsPending: 6,
}
