import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { AcknowledgeDeclineButton } from '@/components/AcknowledgeDeclineButton'

describe('AcknowledgeDeclineButton', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    refresh.mockClear()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs to the acknowledge-decline route and refreshes on 200', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 42 }), { status: 200 }))
    render(<AcknowledgeDeclineButton assignmentId={42} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark handled' }))
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith('/api/front-desk/assignments/42/acknowledge-decline', { method: 'POST' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the server error on 409', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'This decline has already been marked handled.' }), { status: 409 }),
    )
    render(<AcknowledgeDeclineButton assignmentId={42} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark handled' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This decline has already been marked handled.')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('on a rejected fetch shows the fallback error and re-enables the button', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<AcknowledgeDeclineButton assignmentId={42} />)
    const button = screen.getByRole('button', { name: 'Mark handled' })
    fireEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not mark this decline handled.')
    await waitFor(() => expect(button).not.toBeDisabled())
    expect(refresh).not.toHaveBeenCalled()
  })
})
