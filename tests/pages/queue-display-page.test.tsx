import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import QueueDisplayPage from '@/app/display/queue/page'

const TICKETS = [
  { ticketNumber: 3, urgency: 'routine', stage: 'waiting', providerName: 'Dr Meera Iyer', room: 'OPD 2' },
  { ticketNumber: 4, urgency: 'routine', stage: 'ready', providerName: 'Dr Meera Iyer', room: 'OPD 2' },
  { ticketNumber: 5, urgency: 'urgent', stage: 'ready', providerName: 'Dr Arjun Rao', room: 'OPD 5' },
  { ticketNumber: 7, urgency: 'routine', stage: 'ready', providerName: 'Dr Meera Iyer', room: null },
  { ticketNumber: 9, urgency: 'emergency', stage: 'ready', providerName: 'Dr Arjun Rao', room: 'Ward A 101' },
]

beforeEach(() => {
  sessionStorage.setItem('queueDisplayPin', '123456')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tickets: TICKETS }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

function at(url: string) {
  window.history.replaceState(null, '', url)
}

describe('/display/queue', () => {
  it('shows the three most recent ready tokens as "Now serving" with doctor and room', async () => {
    at('/display/queue?lang=en')
    render(<QueueDisplayPage />)
    const band = await screen.findByRole('region', { name: 'Now serving' })
    const tokens = within(band).getAllByTestId('now-serving-token').map((el) => el.getAttribute('data-ticket'))
    expect(tokens).toEqual(['9', '7', '5'])
    expect(within(band).getByText('Dr Arjun Rao, Room Ward A 101')).toBeInTheDocument()
    expect(within(band).getByText('Dr Meera Iyer')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Waiting' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Ready' })).toBeInTheDocument()
  })

  it('shows Kannada labels for ?lang=kn', async () => {
    at('/display/queue?lang=kn')
    render(<QueueDisplayPage />)
    expect(await screen.findByRole('region', { name: 'ಈಗ ಸೇವೆಯಲ್ಲಿ' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'ಕಾಯುತ್ತಿರುವವರು' })).toBeInTheDocument()
  })

  it('falls back to English for an unknown ?lang and switches language from the toggle', async () => {
    at('/display/queue?lang=xx')
    render(<QueueDisplayPage />)
    expect(await screen.findByRole('region', { name: 'Now serving' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'हिन्दी' }))
    expect(await screen.findByRole('region', { name: 'अब सेवा में' })).toBeInTheDocument()
    expect(window.location.search).toBe('?lang=hi')
  })
})
