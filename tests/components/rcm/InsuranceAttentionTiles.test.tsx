import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InsuranceAttentionTiles } from '@/components/rcm/InsuranceAttentionTiles'

describe('InsuranceAttentionTiles', () => {
  it('links unverified admissions to the RCM policies page, shown by UHID', () => {
    render(<InsuranceAttentionTiles canEditSettings={false} data={{ policiesExpiringIn7Days: 2, claimsBlockedByIdentifiers: 0, admissionsTodayUnverified: [{ admissionId: 1, patientId: 'RD-0001', uhid: 'UH100', name: 'Asha Rao', payerName: 'Star Health' }] }} />)
    expect(screen.getByRole('link', { name: 'UH100' })).toHaveAttribute('href', '/rcm/policies?patientId=RD-0001')
    expect(screen.getByRole('link', { name: 'View policies' })).toHaveAttribute('href', '/rcm/policies?expiring=7')
    expect(screen.queryByText('RD-0001')).toBeNull()
  })
})
