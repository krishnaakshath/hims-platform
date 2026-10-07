import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PatientsTable, type PatientRow } from '@/components/PatientsTable'

const ROWS: PatientRow[] = [
  { id: 'RD-0001', overallStatus: 'green', name: 'Maria Alvarez', dob: '1985-03-12', currentProvider: 'Dr. R. Kunam', referralType: 'Provider referral', lastCommunication: null },
  { id: 'RD-0002', overallStatus: 'red', name: 'James Thornton', dob: '1990-11-02', currentProvider: 'Dr. R. Kunam', referralType: 'Provider referral', lastCommunication: null },
]

describe('PatientsTable', () => {
  it('shows all rows with no search', () => {
    render(<PatientsTable patients={ROWS} />)
    expect(screen.getByText('Maria Alvarez')).toBeInTheDocument()
    expect(screen.getByText('James Thornton')).toBeInTheDocument()
  })

  it('filters rows by name as the user types', () => {
    render(<PatientsTable patients={ROWS} />)
    fireEvent.change(screen.getByLabelText('Search patients'), { target: { value: 'thornton' } })
    expect(screen.queryByText('Maria Alvarez')).not.toBeInTheDocument()
    expect(screen.getByText('James Thornton')).toBeInTheDocument()
  })

  it('filters rows by anon id', () => {
    render(<PatientsTable patients={ROWS} />)
    fireEvent.change(screen.getByLabelText('Search patients'), { target: { value: 'RD-0001' } })
    expect(screen.getByText('Maria Alvarez')).toBeInTheDocument()
    expect(screen.queryByText('James Thornton')).not.toBeInTheDocument()
  })

  it('shows a no-match message when nothing filters in', () => {
    render(<PatientsTable patients={ROWS} />)
    fireEvent.change(screen.getByLabelText('Search patients'), { target: { value: 'nonexistent' } })
    expect(screen.getByText(/No patients match/)).toBeInTheDocument()
  })

  it('clears the search when Clear is clicked', () => {
    render(<PatientsTable patients={ROWS} />)
    fireEvent.change(screen.getByLabelText('Search patients'), { target: { value: 'thornton' } })
    fireEvent.click(screen.getByLabelText('Clear search'))
    expect(screen.getByText('Maria Alvarez')).toBeInTheDocument()
  })

  it('shows verdict chips and criteria readouts by default', () => {
    render(<PatientsTable patients={ROWS} />)
    expect(screen.getByText('Meets')).toBeInTheDocument()
    expect(screen.getByText('Potential Exclusion')).toBeInTheDocument()
    expect(screen.getAllByText('No screening evidence yet')).toHaveLength(2)
  })

  it('omits verdict chips and criteria readouts when showScreening is false', () => {
    render(<PatientsTable patients={ROWS} showScreening={false} showMedicalRecordLink={false} />)
    expect(screen.getByText('Maria Alvarez')).toBeInTheDocument()
    expect(screen.queryByText('Meets')).not.toBeInTheDocument()
    expect(screen.queryByText('Potential Exclusion')).not.toBeInTheDocument()
    expect(screen.queryByText(/screening evidence/)).not.toBeInTheDocument()
    expect(screen.queryByText('Medical Record')).not.toBeInTheDocument()
  })

  // Wave B P1-08: UHID and mobile on every card; server-driven search + pagination on /patients.
  it('shows UHID and mobile on the card, and filters by them client-side', () => {
    const rows = [{ ...ROWS[0], uhid: 'UH000123', phone: '+919876543210' }, ROWS[1]]
    render(<PatientsTable patients={rows} />)
    expect(screen.getByText(/UH000123/)).toBeInTheDocument()
    expect(screen.getByText(/\+91 98765 43210/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search patients'), { target: { value: '98765' } })
    expect(screen.getByText('Maria Alvarez')).toBeInTheDocument()
    expect(screen.queryByText('James Thornton')).not.toBeInTheDocument()
  })

  it('in directory mode, searches with a GET form and pages with links that keep the filter', () => {
    render(<PatientsTable patients={ROWS} directory={{ query: 'rao', page: 2, pageSize: 2, total: 5, params: { trialId: 'trial-a' } }} />)
    const search = screen.getByRole('search')
    expect(search).toHaveAttribute('action', '/patients')
    expect(screen.getByLabelText('Search patients')).toHaveAttribute('name', 'q')
    expect(screen.getByLabelText('Search patients')).toHaveValue('rao')
    expect(search.querySelector('input[type="hidden"][name="trialId"]')).toHaveValue('trial-a')
    const nav = screen.getByRole('navigation', { name: /pagination/i })
    expect(nav.querySelector('a[rel="prev"]')).toHaveAttribute('href', '/patients?trialId=trial-a&q=rao&page=1')
    expect(nav.querySelector('a[rel="next"]')).toHaveAttribute('href', '/patients?trialId=trial-a&q=rao&page=3')
    expect(screen.getByText(/showing 3–4 of 5/i)).toBeInTheDocument()
  })

  it('in directory mode, the no-match message names the server query', () => {
    render(<PatientsTable patients={[]} directory={{ query: 'zzz', page: 1, pageSize: 30, total: 0, params: {} }} />)
    expect(screen.getByText(/No patients match "zzz"/)).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: /pagination/i })).not.toBeInTheDocument()
  })
})
