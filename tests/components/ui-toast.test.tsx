import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ToastProvider, useToast } from '@/components/ui/toast'

type ShowArg = Parameters<ReturnType<typeof useToast>['show']>[0]

function Trigger({ toast }: { toast: ShowArg }) {
  const { show } = useToast()
  return <button onClick={() => show(toast)}>fire</button>
}

function setup(toast: ShowArg) {
  render(
    <ToastProvider>
      <Trigger toast={toast} />
    </ToastProvider>,
  )
}

describe('Toast', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('renders a status region with title and next-step link', () => {
    setup({ title: 'Stock received', action: { label: 'View batches', href: '/x' } })
    fireEvent.click(screen.getByText('fire'))
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Stock received')
    expect(screen.getByRole('link', { name: 'View batches' })).toHaveAttribute('href', '/x')
  })

  it('disappears after 6 seconds', () => {
    setup({ title: 'Saved' })
    fireEvent.click(screen.getByText('fire'))
    expect(screen.getByRole('status')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(5900) })
    expect(screen.getByRole('status')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('disappears on the close button', () => {
    setup({ title: 'Saved', description: 'All good' })
    fireEvent.click(screen.getByText('fire'))
    expect(screen.getByText('All good')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('uses role=alert for error tone', () => {
    setup({ title: 'Failed', tone: 'error' })
    fireEvent.click(screen.getByText('fire'))
    expect(screen.getByRole('alert')).toHaveTextContent('Failed')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('stacks at most 3, dropping the oldest', () => {
    setup({ title: 'Hello' })
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText('fire'))
    expect(screen.getAllByRole('status')).toHaveLength(3)
  })

  it('throws a clear error outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Trigger toast={{ title: 'x' }} />)).toThrow(/useToast must be used within a ToastProvider/)
    spy.mockRestore()
  })
})
