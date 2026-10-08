import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import { InpatientHistoryPanel } from '@/components/InpatientHistoryPanel'

// Wave F P1-13: a discharged admission links to its printable A4 summary.
const base = {
  admissionType: 'elective', admittedAt: '2026-10-01T04:30:00.000Z',
  dischargeDiagnosis: null, dischargeDrugs: null, dischargeDevices: null, dischargeDiet: null, dischargeSummaryNotes: null,
  transfers: [], dischargeSignature: null,
}

describe('InpatientHistoryPanel', () => {
  it('links a discharged admission to /print/discharge/[id], and not a current one', () => {
    render(
      <InpatientHistoryPanel
        admissions={[
          { ...base, id: 41, status: 'discharged', dischargedAt: '2026-10-04T04:30:00.000Z' },
          { ...base, id: 42, status: 'admitted', dischargedAt: null },
        ]}
        availableRooms={[]} canTransfer={false} canDischarge={false} canManageMedications={false}
      />,
    )
    const links = screen.getAllByRole('link', { name: /print discharge summary/i })
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/print/discharge/41')
  })
})
