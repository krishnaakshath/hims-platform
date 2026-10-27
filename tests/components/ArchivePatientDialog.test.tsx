import { describe, it, expect, vi, afterEach } from 'vitest'
import { render as rtlRender, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { ToastProvider } from '@/components/ui/toast'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
import { ArchivePatientDialog } from '@/components/ArchivePatientDialog'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// The dashboard layout wraps every page in ToastProvider; so do these renders.
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ToastProvider })

const TARGET = { id: 'RD-0001', name: 'Test Patient', uhid: 'UH000000017' }

describe('ArchivePatientDialog', () => {
  it('asks for the typed UHID and a reason, and says records are kept', () => {
    render(<ArchivePatientDialog target={TARGET} onClose={vi.fn()} onArchived={vi.fn()} />)
    expect(screen.getByRole('dialog')).toHaveTextContent(/every record is kept/i)
    expect(screen.getByText('UH000000017')).toBeInTheDocument()
    expect(screen.getByLabelText('UHID')).toBeInTheDocument()
    expect(screen.getByLabelText('Reason')).toBeInTheDocument()
  })

  it('keeps Archive disabled until a UHID and a reason of at least 10 characters are entered', () => {
    render(<ArchivePatientDialog target={TARGET} onClose={vi.fn()} onArchived={vi.fn()} />)
    const submit = screen.getByRole('button', { name: /^archive patient$/i })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('UHID'), { target: { value: 'UH000000017' } })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'too short' } })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Duplicate chart' } })
    expect(submit).toBeEnabled()
  })

  it('POSTs the reason and typed UHID to the archive route, then closes', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const onClose = vi.fn()
    const onArchived = vi.fn()
    // Like the real callers, closing unmounts the dialog (so the toast is no longer behind a modal).
    function Harness() {
      const [target, setTarget] = useState<typeof TARGET | null>(TARGET)
      return <ArchivePatientDialog target={target} onClose={() => { onClose(); setTarget(null) }} onArchived={onArchived} />
    }
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('UHID'), { target: { value: 'uh000000017' } })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Duplicate chart' } })
    fireEvent.click(screen.getByRole('button', { name: /^archive patient$/i }))
    await waitFor(() => expect(onArchived).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/patients/RD-0001/archive')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'Duplicate chart', confirmUhid: 'uh000000017' })
    // WS7 T16: "Archived" toast; Undo opens the archived chart, whose banner restores it.
    expect(screen.getByText('Archived')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Undo' })).toHaveAttribute('href', '/patients/RD-0001')
  })

  it("shows the route's mismatch message and stays open", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'The UHID you typed does not match this patient.', code: 'uhid_mismatch' }), { status: 400 })))
    const onArchived = vi.fn()
    render(<ArchivePatientDialog target={TARGET} onClose={vi.fn()} onArchived={onArchived} />)
    fireEvent.change(screen.getByLabelText('UHID'), { target: { value: 'UH000000025' } })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Duplicate chart' } })
    fireEvent.click(screen.getByRole('button', { name: /^archive patient$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The UHID you typed does not match this patient.')
    expect(onArchived).not.toHaveBeenCalled()
  })

  it('renders nothing with no target', () => {
    const { container } = render(<ArchivePatientDialog target={null} onClose={vi.fn()} onArchived={vi.fn()} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(container).toHaveTextContent(/^$/) // only the (empty) toast region from the provider
  })
})
