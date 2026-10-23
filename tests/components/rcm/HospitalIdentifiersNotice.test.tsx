import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HospitalIdentifiersNotice } from '@/components/rcm/HospitalIdentifiersNotice'

describe('HospitalIdentifiersNotice', () => {
  it('renders nothing when both identifiers exist', () => {
    const { container } = render(<HospitalIdentifiersNotice missing={[]} canEdit />)
    expect(container).toBeEmptyDOMElement()
  })
  it('tells a non-admin to ask an administrator, with no link', () => {
    render(<HospitalIdentifiersNotice missing={['rohini']} canEdit={false} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent("The hospital's ROHINI ID is not set: claims and NHCX eligibility checks are blocked.")
    expect(alert).toHaveTextContent('Ask an administrator to set it in RCM settings.')
    expect(screen.queryByRole('link')).toBeNull()
  })
  it('gives an admin the link to RCM settings', () => {
    render(<HospitalIdentifiersNotice missing={['hfr']} canEdit />)
    expect(screen.getByRole('alert')).toHaveTextContent("The hospital's HFR facility ID is not set: claims and NHCX eligibility checks are blocked.")
    expect(screen.getByRole('link', { name: 'Set it in RCM settings' })).toHaveAttribute('href', '/rcm/settings')
  })
  it('names both when both are missing', () => {
    render(<HospitalIdentifiersNotice missing={['rohini', 'hfr']} canEdit />)
    expect(screen.getByRole('alert')).toHaveTextContent("The hospital's ROHINI ID and HFR facility ID are not set")
  })
})
