import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BroadcastWizard } from '@/components/BroadcastWizard'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

afterEach(() => {
  vi.unstubAllGlobals()
})

const TRIALS = [{ id: 'nct06911112', condition: 'Major Depressive Disorder' }]

const PREVIEW = { counts: { match: 212, optedOut: 18, noPhone: 7, sendable: 187 }, recipients: [{ id: 'RD-0001', uhid: 'UH-0001', name: 'Asha Rao' }] }

async function toReview(preview: unknown = PREVIEW) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(preview), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  fireEvent.change(screen.getByLabelText(/Message/i), { target: { value: 'Free eye camp this Sunday.' } })
  fireEvent.click(screen.getByText('Next: Specify Recipients'))
  fireEvent.click(screen.getByText('Preview Recipients'))
  await screen.findByText('212 match · 18 opted out · 7 no phone')
  fireEvent.click(screen.getByText('Next: Review and Send'))
  return fetchMock
}

describe('BroadcastWizard', () => {
  it('disables Next until a message is entered', () => {
    render(<BroadcastWizard trials={TRIALS} />)
    expect(screen.getByText('Next: Specify Recipients')).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Message/i), { target: { value: 'Reminder to complete your form.' } })
    expect(screen.getByText('Next: Specify Recipients')).not.toBeDisabled()
  })

  it('refuses a message over 140 characters', () => {
    render(<BroadcastWizard trials={TRIALS} />)
    fireEvent.change(screen.getByLabelText(/Message/i), { target: { value: 'x'.repeat(141) } })
    expect(screen.getByText('Next: Specify Recipients')).toBeDisabled()
    expect(screen.getByText('141/140 characters')).toBeInTheDocument()
  })

  it('disables advancing to Review until recipients have been previewed, then shows the counts line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PREVIEW), { status: 200 })))
    render(<BroadcastWizard trials={TRIALS} />)
    fireEvent.change(screen.getByLabelText(/Message/i), { target: { value: 'Reminder to complete your form.' } })
    fireEvent.click(screen.getByText('Next: Specify Recipients'))
    expect(screen.getByText('Next: Review and Send')).toBeDisabled()
    fireEvent.click(screen.getByText('Preview Recipients'))
    await screen.findByText('212 match · 18 opted out · 7 no phone')
    expect(screen.getByText(/187 patients will receive this message/)).toBeInTheDocument()
    expect(screen.getByText('Next: Review and Send')).not.toBeDisabled()
  })

  it('sends the hospital filters as query parameters (age, PIN prefix, department)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(PREVIEW), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<BroadcastWizard trials={TRIALS} showTrialFilters={false} departments={[{ id: 4, name: 'Cardiology' }]} />)
    fireEvent.change(screen.getByLabelText(/Message/i), { target: { value: 'Camp' } })
    fireEvent.click(screen.getByText('Next: Specify Recipients'))
    fireEvent.change(screen.getByLabelText('Minimum age'), { target: { value: '60' } })
    fireEvent.change(screen.getByLabelText('PIN code starts with'), { target: { value: '560' } })
    fireEvent.change(screen.getByLabelText(/Department/), { target: { value: '4' } })
    fireEvent.click(screen.getByText('Preview Recipients'))
    await screen.findByText('212 match · 18 opted out · 7 no phone')
    const url = String((fetchMock.mock.calls[0] as unknown[])[0])
    expect(url).toContain('departmentId=4')
    expect(url).toContain('ageMin=60')
    expect(url).toContain('pinCodePrefix=560')
  })

  it('shows trial filters only when trials are enabled', () => {
    const { unmount } = render(<BroadcastWizard trials={TRIALS} showTrialFilters={false} />)
    fireEvent.change(screen.getByLabelText(/Message/i), { target: { value: 'Camp' } })
    fireEvent.click(screen.getByText('Next: Specify Recipients'))
    expect(screen.queryByLabelText('Trial')).toBeNull()
    expect(screen.queryByLabelText('Screening Status')).toBeNull()
    unmount()
    render(<BroadcastWizard trials={TRIALS} showTrialFilters />)
    fireEvent.change(screen.getByLabelText(/Message/i), { target: { value: 'Camp' } })
    fireEvent.click(screen.getByText('Next: Specify Recipients'))
    expect(screen.getByLabelText('Trial')).toBeInTheDocument()
  })

  it('blocks Send until the typed number matches the recipient count, then posts confirmCount', async () => {
    render(<BroadcastWizard trials={TRIALS} />)
    const fetchMock = await toReview()
    const sendButton = screen.getByRole('button', { name: 'Send to 187 patients' })
    expect(sendButton).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type 187 to confirm the number of recipients'), { target: { value: '18' } })
    expect(sendButton).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type 187 to confirm the number of recipients'), { target: { value: '187' } })
    expect(sendButton).not.toBeDisabled()

    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ id: 9, recipientCount: 212, sentCount: 180, skippedCount: 25, failedCount: 7 }), { status: 201 }))
    fireEvent.click(sendButton)
    await screen.findByText('Broadcast sent to 180 patients.')
    expect(screen.getByText(/180 sent · 25 skipped · 7 not delivered/)).toBeInTheDocument()
    const [, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ message: 'Free eye camp this Sunday.', filters: {}, confirmCount: 187 })
  })

  it('on 409 count_changed reloads the count and asks for it again', async () => {
    render(<BroadcastWizard trials={TRIALS} />)
    const fetchMock = await toReview()
    fireEvent.change(screen.getByLabelText('Type 187 to confirm the number of recipients'), { target: { value: '187' } })
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'changed', code: 'count_changed', count: 190 }), { status: 409 }))
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ ...PREVIEW, counts: { ...PREVIEW.counts, match: 215, sendable: 190 } }), { status: 200 }))
    fireEvent.click(screen.getByRole('button', { name: 'Send to 187 patients' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The number of recipients has changed')
    expect(screen.getByRole('button', { name: 'Send to 190 patients' })).toBeDisabled()
    expect(screen.getByLabelText('Type 190 to confirm the number of recipients')).toHaveValue('')
  })
})
