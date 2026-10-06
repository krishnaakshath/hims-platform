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
})
