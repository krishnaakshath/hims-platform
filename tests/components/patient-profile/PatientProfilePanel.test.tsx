import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import { PatientProfilePanel, type ProfileView } from '@/components/patient-profile/PatientProfilePanel'

const patient: ProfileView = {
  id: 'RD-0001', uhid: 'UH-000001', gender: 'female', maritalStatus: 'married', bloodGroup: 'O+', occupation: 'Teacher',
  nationality: 'IN', religion: null, preferredLanguage: 'hi', addressLine1: '12 MG Road', addressLine2: null, city: 'Pune',
  district: 'Pune', stateCode: 'IN-MH', pinCode: '411001', phone: '+919876543210', email: 'a@b.example',
  abhaNumber: '12345678901234', abhaAddress: 'asha.rao@abdm', abhaUnavailableReason: null, isMlc: true, mlcNumber: 'MLC-9',
  contacts: [{ kind: 'emergency', name: 'Ravi Rao', relationship: 'spouse', phone: '+919811111111', addressText: null, isPrimary: true }],
}
const aadhaar = { status: 'on_file' as const, masked: 'XXXX XXXX 0124', declineReason: null }

describe('PatientProfilePanel', () => {
  it('formats ABHA number, state name and shows the MLC badge', () => {
    render(<PatientProfilePanel patient={patient} aadhaar={aadhaar} canEdit canWriteAadhaar />)
    expect(screen.getByText('12-3456-7890-1234')).toBeInTheDocument()
    expect(screen.getByText(/Maharashtra/)).toBeInTheDocument()
    expect(screen.getByText('MLC')).toBeInTheDocument()
    expect(screen.getByText('Ravi Rao', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('XXXX XXXX 0124')).toBeInTheDocument()
  })

  it('no MLC badge for a non-MLC patient; shows the ABHA unavailable reason', () => {
    render(<PatientProfilePanel patient={{ ...patient, isMlc: false, mlcNumber: null, abhaNumber: null, abhaAddress: null, abhaUnavailableReason: 'not_created' }} aadhaar={aadhaar} canEdit={false} canWriteAadhaar={false} />)
    expect(screen.queryByText('MLC')).not.toBeInTheDocument()
    expect(screen.getByText(/ABHA not created yet/)).toBeInTheDocument()
  })

  it('shows Edit profile only when canEdit', () => {
    const { unmount } = render(<PatientProfilePanel patient={patient} aadhaar={aadhaar} canEdit canWriteAadhaar={false} />)
    expect(screen.getByRole('button', { name: /edit profile/i })).toBeInTheDocument()
    unmount()
    render(<PatientProfilePanel patient={patient} aadhaar={aadhaar} canEdit={false} canWriteAadhaar={false} />)
    expect(screen.queryByRole('button', { name: /edit profile/i })).not.toBeInTheDocument()
  })
})
