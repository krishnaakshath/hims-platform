import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AdverseEventsPanel, DrugAccountabilityPanel, RegulatoryDocumentsPanel } from '@/components/TrialCompliancePanels'
import type { AdverseEventRow } from '@/lib/queries/trial-compliance'
import { CLIENT_ERROR_MESSAGES, mockFetch, mockFetchReject } from './helpers'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
afterEach(() => { vi.unstubAllGlobals(); refresh.mockClear() })

const event = {
  id: 7, patientId: 'RD-0001', patientName: 'Jane Doe', description: 'Headache', severity: 'severe', serious: true,
  causality: 'possibly', onsetDate: '2026-09-01', reportedDate: '2026-09-02', reportedByName: 'CRC', outcome: 'ongoing',
  sponsorNotifiedAt: null, irbNotifiedAt: null,
} as unknown as AdverseEventRow
const patients = [{ id: 'RD-0001', name: 'Jane Doe' }]

describe('AdverseEventsPanel notify', () => {
  it('shows a failed notification in an alert and does not refresh', async () => {
    mockFetch(500, { error: 'pg exploded' })
    render(<AdverseEventsPanel trialId="t1" events={[event]} patients={patients} canWrite />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark sponsor notified' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(screen.getByRole('alert')).not.toHaveTextContent('pg exploded')
    expect(refresh).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark sponsor notified' })).toBeEnabled())
  })

  it('shows the route\'s 409 message', async () => {
    mockFetch(409, { error: 'This notification has already been recorded.' })
    render(<AdverseEventsPanel trialId="t1" events={[event]} patients={patients} canWrite />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark IRB notified' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already been recorded')
  })

  it('refreshes on success', async () => {
    mockFetch(200, { ok: true })
    render(<AdverseEventsPanel trialId="t1" events={[event]} patients={patients} canWrite />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark sponsor notified' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('Add Adverse Event modal', () => {
  it('surfaces a network failure and re-enables Log Event', async () => {
    mockFetchReject()
    render(<AdverseEventsPanel trialId="t1" events={[]} patients={patients} canWrite />)
    fireEvent.click(screen.getByRole('button', { name: 'Log Adverse Event' }))
    const dialog = screen.getByRole('dialog')
    const selects = dialog.querySelectorAll('select')
    fireEvent.change(selects[0], { target: { value: 'RD-0001' } })
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'Rash' } })
    fireEvent.change(dialog.querySelectorAll('input[type="date"]')[0], { target: { value: '2026-09-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Log Event' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.network)
    expect(screen.getByRole('button', { name: 'Log Event' })).toBeEnabled()
  })
})

describe('Drug accountability modal', () => {
  it('surfaces a 500 with the fixed message', async () => {
    mockFetch(500, { error: 'stack trace' })
    render(<DrugAccountabilityPanel trialId="t1" entries={[]} patients={patients} canWrite />)
    fireEvent.click(screen.getByRole('button', { name: 'Log Entry' }))
    const dialog = screen.getByRole('dialog')
    const inputs = dialog.querySelectorAll('input')
    fireEvent.change(inputs[0], { target: { value: 'LOT-1' } })
    fireEvent.change(inputs[1], { target: { value: '5' } })
    fireEvent.change(inputs[2], { target: { value: '2027-01-01' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Log Entry' }).at(-1)!)
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
  })
})

describe('Regulatory document modal', () => {
  it('surfaces a 403 with the fixed message', async () => {
    mockFetch(403, { error: 'Forbidden' })
    render(<RegulatoryDocumentsPanel trialId="t1" documents={[]} canWrite />)
    fireEvent.click(screen.getByRole('button', { name: 'Add Document' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(dialog.querySelectorAll('input')[0], { target: { value: 'IRB letter' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add Document' }).at(-1)!)
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.forbidden)
  })
})
