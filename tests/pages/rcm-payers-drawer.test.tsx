import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// WS7 T16: /rcm/payers is list-first; "Add insurer or TPA" opens a right-side drawer with the
// profile form, and a successful save shows a toast linking to the new payer.
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const profile = {
  payerId: 5, kind: 'insurer', shortName: null, irdaiRegistrationNo: null, nhcxParticipantCode: null, defaultChannel: 'portal', portalUrl: null, claimsEmail: null, empanelmentStatus: 'empanelled',
  empanelledFrom: null, empanelledTo: null, agreementReference: null, preauthSlaHours: 1, claimSettlementSlaDays: 30, queryResponseDays: 7, submissionWindowDays: 15,
  requiresAbha: false, requiresPreauthForIpd: true, active: true, notes: null, updatedAt: new Date(), updatedByName: 'x',
}

async function renderPage(rows: unknown[]) {
  vi.resetModules()
  const push = vi.fn()
  const refresh = vi.fn()
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'rcm', name: 'Farah', userId: 3 })) }))
  vi.doMock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }), useRouter: () => ({ refresh, push }) }))
  vi.doMock('@/lib/queries/rcm-payers', () => ({ listRcmPayers: vi.fn(async () => rows) }))
  const { default: Page } = await import('@/app/(dashboard)/rcm/payers/page')
  const { ToastProvider } = await import('@/components/ui/toast')
  const rtl = await import('@testing-library/react')
  rtl.render(<ToastProvider>{await Page()}</ToastProvider>)
  return { ...rtl, push, refresh }
}

describe('/rcm/payers drawer', () => {
  it('renders the payer list without the form until "Add insurer or TPA" is pressed', async () => {
    const { screen, fireEvent } = await renderPage([{ payerId: 5, name: 'Star Health', code: 'STAR', gstin: null, stateCode: null, profile }])
    expect(screen.getByRole('link', { name: 'Star Health' })).toHaveAttribute('href', '/rcm/payers/5')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add insurer or TPA' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Code (capitals, digits, -)')
  })

  it('saving closes the drawer and shows a toast linking to the new payer', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ payerId: 42 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const { screen, fireEvent, within, waitFor, push, refresh } = await renderPage([{ payerId: 5, name: 'Star Health', code: 'STAR', gstin: null, stateCode: null, profile }])
    fireEvent.click(screen.getByRole('button', { name: 'Add insurer or TPA' }))
    const dialog = await screen.findByRole('dialog')
    const [nameInput, codeInput] = within(dialog).getAllByRole('textbox')
    fireEvent.change(nameInput, { target: { value: 'Care Health' } })
    fireEvent.change(codeInput, { target: { value: 'care' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add insurer or TPA' }))
    const link = await screen.findByRole('link', { name: 'Open payer' })
    expect(link).toHaveAttribute('href', '/rcm/payers/42')
    expect(screen.getByText('Insurer or TPA added')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/rcm/payers', expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(refresh).toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('shows the shared empty state when there are no payers', async () => {
    const { screen } = await renderPage([])
    expect(screen.getByText('No insurers or TPAs yet')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
