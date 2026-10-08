import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { NotificationPanel } from '@/components/NotificationPanel'

vi.mock('next/link', () => ({ default: ({ href, children, onClick, ...rest }: { href: string; children: React.ReactNode; onClick?: () => void }) => <a href={href} onClick={(e) => { e.preventDefault(); onClick?.() }} {...rest}>{children}</a> }))

const item = (key: string, read = false, over: Record<string, unknown> = {}) => ({
  key, kind: 'booking_request', title: 'New appointment request', detail: 'Asha Rao · prefers 20 Oct 2026', href: '/booking-requests',
  occurredAt: '2026-10-08T04:30:00.000Z', severity: 'info', read, ...over,
})
const FEED = { items: [item('booking_request:1'), item('lab_critical:7', false, { kind: 'lab_critical', title: 'Critical lab result', detail: 'Haemoglobin · Maria Alvarez', severity: 'critical', href: '/patients/RD-0001' }), item('booking_request:2', true, { detail: 'Ravi Kumar · prefers 21 Oct 2026' })], unreadCount: 2 }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function stub(handler: (url: string, init?: RequestInit) => Response) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => { vi.unstubAllGlobals() })

// Wave G P2-01: the bell is a real per-user feed for every staff role.
describe('NotificationPanel', () => {
  it('shows the unread count from the feed on the bell, and never reads the audit log', async () => {
    const fetchFn = stub(() => json(FEED))
    render(<NotificationPanel />)
    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' })
    expect(within(bell).getByText('2')).toBeInTheDocument()
    expect(fetchFn.mock.calls.map((c) => String(c[0]))).toEqual(['/api/notifications'])
  })

  it('opens a labelled panel listing each item as a link, and Escape closes it back to the bell', async () => {
    stub(() => json(FEED))
    render(<NotificationPanel />)
    const bell = await screen.findByRole('button', { name: /notifications, 2 unread/i })
    expect(bell).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(bell)
    expect(bell).toHaveAttribute('aria-expanded', 'true')
    const panel = await screen.findByRole('dialog', { name: /notifications/i })
    expect(within(panel).getByRole('link', { name: /critical lab result/i })).toHaveAttribute('href', '/patients/RD-0001')
    expect(within(panel).getAllByRole('link')).toHaveLength(3)
    expect(within(panel).getAllByText('8 Oct 2026, 10:00 am')).toHaveLength(3)
    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(bell).toHaveFocus()
  })

  it('marks an item read when it is opened', async () => {
    const fetchFn = stub((url) => (url === '/api/notifications/read' ? json({ ...FEED, unreadCount: 1, items: FEED.items.map((i) => (i.key === 'booking_request:1' ? { ...i, read: true } : i)) }) : json(FEED)))
    render(<NotificationPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /notifications, 2 unread/i }))
    fireEvent.click(await screen.findByRole('link', { name: /asha rao/i }))
    await waitFor(() => expect(fetchFn.mock.calls.some((c) => String(c[0]) === '/api/notifications/read')).toBe(true))
    const call = fetchFn.mock.calls.find((c) => String(c[0]) === '/api/notifications/read')!
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ keys: ['booking_request:1'] })
    await screen.findByRole('button', { name: /notifications, 1 unread/i })
  })

  it('marks everything read', async () => {
    const fetchFn = stub((url) => (url === '/api/notifications/read' ? json({ items: FEED.items.map((i) => ({ ...i, read: true })), unreadCount: 0 }) : json(FEED)))
    render(<NotificationPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /notifications, 2 unread/i }))
    fireEvent.click(await screen.findByRole('button', { name: /mark all as read/i }))
    await screen.findByRole('button', { name: 'Notifications' })
    const call = fetchFn.mock.calls.find((c) => String(c[0]) === '/api/notifications/read')!
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ all: true })
  })

  it('says so when there is nothing new', async () => {
    stub(() => json({ items: [], unreadCount: 0 }))
    render(<NotificationPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }))
    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /mark all as read/i })).not.toBeInTheDocument()
  })

  it('shows an error inside the panel when the feed cannot load', async () => {
    stub(() => json({ error: 'Could not load notifications' }, 500))
    render(<NotificationPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i)
  })
})
