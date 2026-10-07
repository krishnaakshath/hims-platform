import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { CorrectDemographicsButton } from '@/components/patient-profile/CorrectDemographicsButton'

beforeEach(() => { refresh.mockReset(); vi.unstubAllGlobals() })

const openDialog = () => {
  render(<CorrectDemographicsButton anonId="RD-0001" name="Asha Raoo" dob="1990-01-01" />)
  fireEvent.click(screen.getByRole('button', { name: /correct name/i }))
}

// Wave C P1-11
describe('CorrectDemographicsButton', () => {
  it('sends only the changed field with the reason, then refreshes', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    openDialog()
    expect(screen.getByLabelText('Full name')).toHaveValue('Asha Raoo')
    expect(screen.getByLabelText('Date of birth')).toHaveValue('1990-01-01')
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Asha Rao' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Typo at registration' } })
    fireEvent.click(screen.getByRole('button', { name: /save correction/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/patients/RD-0001/demographics')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Asha Rao', reason: 'Typo at registration' })
  })

  it('requires a change and a reason before sending', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    openDialog()
    fireEvent.click(screen.getByRole('button', { name: /save correction/i }))
    expect(await screen.findByText(/change the name or the date of birth/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1990-01-10' } })
    fireEvent.click(screen.getByRole('button', { name: /save correction/i }))
    expect(await screen.findByText(/give a reason/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the server error and stays open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'A guardian contact is required for a patient under 18' }), { status: 400 })))
    openDialog()
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '2015-01-01' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Wrong year' } })
    fireEvent.click(screen.getByRole('button', { name: /save correction/i }))
    expect(await screen.findByText(/guardian contact is required/i)).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })
})
