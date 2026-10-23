import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PatientPortalSideNav } from '@/components/PatientPortalSideNav'
import { BrandProvider } from '@/components/BrandProvider'

vi.mock('next/navigation', () => ({ usePathname: () => '/patient-portal/messages' }))

describe('PatientPortalSideNav', () => {
  it('renders the brand wordmark instead of any logo image', () => {
    render(<PatientPortalSideNav />)
    expect(screen.getByText('HIMS')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('gives the active nav link a filled rounded-full pill background, not a left border bar', () => {
    render(<PatientPortalSideNav />)
    const activeLink = screen.getByRole('link', { name: /messages/i, current: 'page' })
    expect(activeLink.className).toMatch(/rounded-full/)
    expect(activeLink.className).not.toMatch(/border-l-2/)
  })

  // SP5 Task 15
  it('links Lab reports right after Medications', () => {
    render(<PatientPortalSideNav />)
    const labels = screen.getAllByRole('link').map((l) => l.textContent?.trim())
    expect(screen.getByRole('link', { name: /lab reports/i })).toHaveAttribute('href', '/patient-portal/lab-reports')
    expect(labels.indexOf('Lab reports')).toBe(labels.indexOf('Medications') + 1)
  })
})

// Wave J (P1-20)
describe('PatientPortalSideNav Wave J entries', () => {
  it('links prescriptions, discharge summaries, bills and insurance', () => {
    render(<PatientPortalSideNav />)
    expect(screen.getByRole('link', { name: 'Prescriptions' })).toHaveAttribute('href', '/patient-portal/prescriptions')
    expect(screen.getByRole('link', { name: 'Discharge summaries' })).toHaveAttribute('href', '/patient-portal/discharge-summaries')
    expect(screen.getByRole('link', { name: 'Bills & receipts' })).toHaveAttribute('href', '/patient-portal/bills')
    expect(screen.getByRole('link', { name: 'Insurance & ABHA' })).toHaveAttribute('href', '/patient-portal/insurance')
  })
})

// WL T9 (R6): the section label is the configured portal name (default "Patient portal").
describe('PatientPortalSideNav portal name', () => {
  it('labels the section with the default portal name', () => {
    render(<PatientPortalSideNav />)
    expect(screen.getByText('Patient portal')).toBeInTheDocument()
  })

  it('labels the section with the stored portal name from the brand', () => {
    render(<BrandProvider brand={{ name: 'Sunrise Hospital', portalName: 'Sunrise MyCare' }}><PatientPortalSideNav /></BrandProvider>)
    expect(screen.getByText('Sunrise MyCare')).toBeInTheDocument()
    expect(screen.queryByText('Patient portal')).not.toBeInTheDocument()
  })
})
