import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MedicationHistorySection, type PrescriberInfo } from '@/components/MedicationHistorySection'
import type { medicationEpisodes } from '@/db/schema'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

type Episode = typeof medicationEpisodes.$inferSelect

// Base fixture carrying every column so each test only overrides what it
// cares about -- matches the DB row shape (`typeof medicationEpisodes.$inferSelect`)
// but is built as a plain object per the brief, not a real DB row.
function episode(overrides: Partial<Episode> & { id: number }): Episode {
  return {
    patientId: 'RD-0001',
    name: 'Sertraline',
    medicationClass: 'SSRI',
    dose: null,
    startDate: '2026-03-12',
    stopDate: null,
    status: 'active',
    medicationId: null,
    frequencyPerDay: null,
    durationDays: null,
    instructions: null,
    prescribedByProviderId: null,
    enteredByName: null,
    prescribedAt: null,
    ...overrides,
  } as Episode
}

const kunam: PrescriberInfo = { name: 'Dr. Rajiv Kunam', credentials: 'MD', specialty: 'Psychiatry' }
const chen: PrescriberInfo = { name: 'Dr. Anna Chen', credentials: null, specialty: 'Neurology' }

const baseProps = {
  patientId: 'RD-0001',
  catalog: [],
  specialties: ['Psychiatry', 'Neurology'],
  activeProviders: [],
  needsOnBehalfOf: false,
  diagnosisCodes: [],
}

describe('MedicationHistorySection', () => {
  it('renders an imported row exactly as it does today', () => {
    render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[episode({ id: 1, dose: '10mg', startDate: '2026-03-12', status: 'active' })]}
        prescriberById={{}}
        canPrescribe={false}
      />
    )
    expect(screen.getByText('10mg · started Mar 12, 2026')).toBeInTheDocument()
    expect(screen.queryByText(/Prescribed by/)).not.toBeInTheDocument()
    expect(screen.queryByText('Print')).not.toBeInTheDocument()
  })

  it('renders "Dose not recorded" for an imported row with a null dose', () => {
    render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[episode({ id: 1, dose: null, startDate: '2026-03-12', status: 'active' })]}
        prescriberById={{}}
        canPrescribe={false}
      />
    )
    expect(screen.getByText('Dose not recorded · started Mar 12, 2026')).toBeInTheDocument()
  })

  it('renders the composed sig for a prescribed row', () => {
    render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[episode({
          id: 1, dose: '50mg', frequencyPerDay: 2, durationDays: 30, startDate: '2026-03-12',
          prescribedAt: new Date('2026-09-29T17:04:00Z'), prescribedByProviderId: 1,
        })]}
        prescriberById={{ 1: kunam }}
        canPrescribe={false}
      />
    )
    expect(screen.getByText('50mg · 2 times daily · 30 days · started Mar 12, 2026')).toBeInTheDocument()
  })

  it('renders instructions on their own line', () => {
    render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[episode({
          id: 1, dose: '50mg', frequencyPerDay: 2, durationDays: 30, instructions: 'Take with food',
          prescribedAt: new Date('2026-09-29T17:04:00Z'), prescribedByProviderId: 1,
        })]}
        prescriberById={{ 1: kunam }}
        canPrescribe={false}
      />
    )
    expect(screen.getByText('Take with food')).toBeInTheDocument()
  })

  it('renders the prescriber line resolved through prescriberById', () => {
    render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[episode({
          id: 1, dose: '50mg', frequencyPerDay: 2, durationDays: 30,
          prescribedAt: new Date('2026-09-29T17:04:00Z'), prescribedByProviderId: 1,
        })]}
        prescriberById={{ 1: kunam }}
        canPrescribe={false}
      />
    )
    expect(screen.getByText('Prescribed by Dr. Rajiv Kunam, MD · Psychiatry · Sep 29, 2026')).toBeInTheDocument()
  })

  it('appends "Entered by" only when it differs from the prescriber\'s name', () => {
    const { rerender } = render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[episode({
          id: 1, prescribedAt: new Date('2026-09-29T17:04:00Z'), prescribedByProviderId: 1, enteredByName: 'Front Desk Staffer',
        })]}
        prescriberById={{ 1: kunam }}
        canPrescribe={false}
      />
    )
    expect(screen.getByText('Prescribed by Dr. Rajiv Kunam, MD · Psychiatry · Sep 29, 2026 · Entered by Front Desk Staffer')).toBeInTheDocument()

    rerender(
      <MedicationHistorySection
        {...baseProps}
        episodes={[episode({
          id: 1, prescribedAt: new Date('2026-09-29T17:04:00Z'), prescribedByProviderId: 1, enteredByName: 'Dr. Rajiv Kunam',
        })]}
        prescriberById={{ 1: kunam }}
        canPrescribe={false}
      />
    )
    expect(screen.getByText('Prescribed by Dr. Rajiv Kunam, MD · Psychiatry · Sep 29, 2026')).toBeInTheDocument()
    expect(screen.queryByText(/Entered by/)).not.toBeInTheDocument()
  })

  it('renders a Print link to /prescriptions/print?ids=<id> for a prescribed row', () => {
    render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[episode({
          id: 42, prescribedAt: new Date('2026-09-29T17:04:00Z'), prescribedByProviderId: 1,
        })]}
        prescriberById={{ 1: kunam }}
        canPrescribe={false}
      />
    )
    expect(screen.getByText('Print')).toHaveAttribute('href', '/prescriptions/print?ids=42')
  })

  it('renders the same date whether prescribedAt is a Date or an ISO string (Review Focus #5)', () => {
    const { unmount } = render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[episode({ id: 1, prescribedAt: new Date('2026-09-29T17:04:00Z'), prescribedByProviderId: 1 })]}
        prescriberById={{ 1: kunam }}
        canPrescribe={false}
      />
    )
    expect(screen.getByText('Prescribed by Dr. Rajiv Kunam, MD · Psychiatry · Sep 29, 2026')).toBeInTheDocument()
    unmount()

    // A Redis cache-hit shape: `prescribedAt` comes back as an ISO string,
    // not a Date instance, since JSON has no Date type. Cast through
    // `unknown` deliberately -- the static Episode type says `Date | null`,
    // but the real runtime value on this path is a string, which is exactly
    // what this test exists to exercise.
    const stringPrescribedAtEpisode = episode({ id: 1, prescribedByProviderId: 1, prescribedAt: new Date('2026-09-29T17:04:00Z') })
    const asStringShape = { ...stringPrescribedAtEpisode, prescribedAt: '2026-09-29T17:04:00.000Z' } as unknown as Episode

    expect(() =>
      render(
        <MedicationHistorySection
          {...baseProps}
          episodes={[asStringShape]}
          prescriberById={{ 1: kunam }}
          canPrescribe={false}
        />
      )
    ).not.toThrow()
    expect(screen.getByText('Prescribed by Dr. Rajiv Kunam, MD · Psychiatry · Sep 29, 2026')).toBeInTheDocument()
  })

  it('renders no "Add prescription" button and no Stop action when canPrescribe is false', () => {
    render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[episode({ id: 1, status: 'active' })]}
        prescriberById={{}}
        canPrescribe={false}
      />
    )
    expect(screen.queryByText('Add prescription')).not.toBeInTheDocument()
    expect(screen.queryByText('Stop')).not.toBeInTheDocument()
  })

  it('renders both when canPrescribe is true, and Stop only on active rows', () => {
    render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[
          episode({ id: 1, status: 'active' }),
          episode({ id: 2, status: 'inactive', stopDate: '2026-04-01' }),
        ]}
        prescriberById={{}}
        canPrescribe={true}
      />
    )
    expect(screen.getByText('Add prescription')).toBeInTheDocument()
    expect(screen.getAllByText('Stop')).toHaveLength(1)
  })

  it('renders the specialty facet only when prescribed rows span more than one specialty', () => {
    const { unmount } = render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[
          episode({ id: 1, name: 'Sertraline', prescribedAt: new Date('2026-09-29T17:04:00Z'), prescribedByProviderId: 1 }),
          episode({ id: 2, name: 'Fluoxetine', prescribedAt: new Date('2026-09-29T17:04:00Z'), prescribedByProviderId: 1 }),
        ]}
        prescriberById={{ 1: kunam }}
        canPrescribe={false}
      />
    )
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    unmount()

    render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[
          episode({ id: 1, name: 'Sertraline', prescribedAt: new Date('2026-09-29T17:04:00Z'), prescribedByProviderId: 1 }),
          episode({ id: 2, name: 'Gabapentin', prescribedAt: new Date('2026-09-29T17:04:00Z'), prescribedByProviderId: 2 }),
        ]}
        prescriberById={{ 1: kunam, 2: chen }}
        canPrescribe={false}
      />
    )
    const facet = screen.getByRole('combobox')
    expect(facet).toBeInTheDocument()
    expect(screen.getByText('Sertraline', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Gabapentin', { exact: false })).toBeInTheDocument()

    fireEvent.change(facet, { target: { value: 'Psychiatry' } })
    expect(screen.getByText('Sertraline', { exact: false })).toBeInTheDocument()
    expect(screen.queryByText('Gabapentin', { exact: false })).not.toBeInTheDocument()
  })

  it('preserves the Currently Taking / Past Medications grouping and renders the empty state', () => {
    render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[
          episode({ id: 1, status: 'active' }),
          episode({ id: 2, status: 'inactive', stopDate: '2026-04-01' }),
        ]}
        prescriberById={{}}
        canPrescribe={false}
      />
    )
    expect(screen.getByText('Currently Taking')).toBeInTheDocument()
    expect(screen.getByText('Past Medications')).toBeInTheDocument()
  })

  it('renders the empty state when episodes is empty', () => {
    render(
      <MedicationHistorySection
        {...baseProps}
        episodes={[]}
        prescriberById={{}}
        canPrescribe={false}
      />
    )
    expect(screen.getByText('No medications recorded.')).toBeInTheDocument()
  })
})
