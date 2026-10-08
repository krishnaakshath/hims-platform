// Wave J (P1-20): the portal identity bar shows the UHID (IST date format), not the internal id.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
import { PatientPortalTopBar } from '@/components/PatientPortalTopBar'

describe('PatientPortalTopBar', () => {
  it('shows the UHID when issued', () => {
    render(<PatientPortalTopBar name="Asha Rao" dob="1980-10-03" patientId="RD-0042" uhid="HIMS000000011" />)
    expect(screen.getByText('DOB 3 Oct 1980 · UHID HIMS000000011')).toBeInTheDocument()
    expect(screen.queryByText(/RD-0042/)).toBeNull()
  })

  it('falls back to the record id before a UHID is issued', () => {
    render(<PatientPortalTopBar name="Asha Rao" dob="1980-10-03" patientId="RD-0042" />)
    expect(screen.getByText('DOB 3 Oct 1980 · RD-0042')).toBeInTheDocument()
  })
})
