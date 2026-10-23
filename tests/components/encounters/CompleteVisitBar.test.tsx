import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('@/lib/client-fetch', () => ({ sendJson: vi.fn() }))
import { sendJson } from '@/lib/client-fetch'
import { CompleteVisitBar } from '@/components/encounters/CompleteVisitBar'
import { WorkspaceShell, type WorkspaceTab } from '@/components/encounters/WorkspaceShell'

const PANELS = Object.fromEntries((['vitals', 'history', 'diagnosis', 'rx', 'orders', 'notes'] as WorkspaceTab[]).map((k) => [k, <p key={k}>{k} panel</p>])) as Record<WorkspaceTab, React.ReactNode>
const MISSING = { ok: false as const, status: 409, error: 'Add a diagnosis or give a reason before completing the visit.', body: { error: 'Add a diagnosis or give a reason before completing the visit.', code: 'diagnosis_missing' } }
const renderBar = () => render(<WorkspaceShell panels={PANELS} footer={<CompleteVisitBar encounterId={5} status="in_consultation" canComplete />} />)

beforeEach(() => {
  refresh.mockReset()
  vi.mocked(sendJson).mockReset()
})

describe('CompleteVisitBar', () => {
  it('posts to the complete route and shows the warnings with a Sign note link to the Notes tab', async () => {
    vi.mocked(sendJson).mockResolvedValue({ ok: true, status: 200, data: { encounter: { id: 5, status: 'completed' }, warnings: ['no_vitals', 'unsigned_notes'] } })
    renderBar()
    fireEvent.click(screen.getByRole('button', { name: 'Complete visit' }))
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith('/api/encounters/5/complete', 'POST', {}))
    const toast = await screen.findByRole('status')
    expect(toast).toHaveTextContent('Visit completed')
    expect(toast).toHaveTextContent(/no vitals were recorded/i)
    expect(toast).toHaveTextContent(/unsigned/i)
    expect(refresh).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Sign note' }))
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true')
  })

  it('on diagnosis_missing asks: "Add diagnosis" jumps to the Diagnosis tab', async () => {
    vi.mocked(sendJson).mockResolvedValue(MISSING)
    renderBar()
    fireEvent.click(screen.getByRole('button', { name: 'Complete visit' }))
    expect(await screen.findByRole('dialog', { name: 'No diagnosis recorded' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add diagnosis' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Diagnosis' })).toHaveAttribute('aria-selected', 'true')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('on diagnosis_missing a reason of at least 5 characters completes the visit with it', async () => {
    vi.mocked(sendJson).mockResolvedValueOnce(MISSING).mockResolvedValueOnce({ ok: true, status: 200, data: { encounter: { id: 5, status: 'completed' }, warnings: [] } })
    renderBar()
    fireEvent.click(screen.getByRole('button', { name: 'Complete visit' }))
    await screen.findByRole('dialog', { name: 'No diagnosis recorded' })
    const submit = screen.getByRole('button', { name: 'Complete without diagnosis' })
    fireEvent.change(screen.getByLabelText('Reason for no diagnosis'), { target: { value: 'abc' } })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Reason for no diagnosis'), { target: { value: 'Review visit only' } })
    fireEvent.click(submit)
    await waitFor(() => expect(sendJson).toHaveBeenLastCalledWith('/api/encounters/5/complete', 'POST', { noDiagnosisReason: 'Review visit only' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Visit completed')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows any other error inline', async () => {
    vi.mocked(sendJson).mockResolvedValue({ ok: false, status: 409, error: 'Visit is closed', body: { error: 'Visit is closed', code: 'visit_closed' } })
    renderBar()
    fireEvent.click(screen.getByRole('button', { name: 'Complete visit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Visit is closed')
  })

  it('a completed visit shows no Complete button', () => {
    render(<CompleteVisitBar encounterId={5} status="completed" canComplete={false} />)
    expect(screen.queryByRole('button', { name: 'Complete visit' })).toBeNull()
    expect(screen.getByText(/visit completed/i)).toBeInTheDocument()
  })
})
