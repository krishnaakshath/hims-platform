import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueueDisplayCard } from '@/components/settings/QueueDisplayCard'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('QueueDisplayCard', () => {
  it('shows "Not set up", then "PIN set" with the generated PIN and an "Open preview" link', async () => {
    const fetchMock = stubFetch(200, { pin: '042917' })
    render(<QueueDisplayCard isAdmin configured={false} />)
    expect(screen.getByText('Not set up')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /open preview/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /generate pin/i }))
    expect(await screen.findByText('042917')).toBeInTheDocument()
    expect(screen.getByText('PIN set')).toBeInTheDocument()
    expect(screen.queryByText('Not set up')).toBeNull()
    expect(screen.getByRole('link', { name: /open preview/i })).toHaveAttribute('href', '/display/queue?lang=en')
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/queue-display-pin/generate', expect.objectContaining({ method: 'POST', body: '{}' }))
  })

  it('shows "PIN set" and the preview link when a PIN is already configured, and keeps the custom PIN form', () => {
    render(<QueueDisplayCard isAdmin configured />)
    expect(screen.getByText('PIN set')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open preview/i })).toHaveAttribute('href', '/display/queue?lang=en')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument()
  })

  it('surfaces a failed generate in an alert', async () => {
    stubFetch(500, { error: 'boom at route.ts:1' })
    render(<QueueDisplayCard isAdmin configured={false} />)
    fireEvent.click(screen.getByRole('button', { name: /generate pin/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong on our side'))
    expect(screen.getByText('Not set up')).toBeInTheDocument()
  })

  it('offers no generate button to a non-admin', () => {
    render(<QueueDisplayCard isAdmin={false} configured={false} />)
    expect(screen.queryByRole('button', { name: /generate pin/i })).toBeNull()
  })
})
