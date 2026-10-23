import { describe, it, expect, vi, afterEach } from 'vitest'
import { render as rtlRender, screen, fireEvent } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { SendFormModal } from '@/components/SendFormModal'
import { ToastProvider } from '@/components/ui/toast'

// The dashboard layout wraps every page in ToastProvider; so do these renders.
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ToastProvider })

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
afterEach(() => vi.unstubAllGlobals())

const SARO = { id: 'RD-0007', name: 'Saroja Devi', uhid: 'UH00000007', gender: 'female', ageYears: 52, phone: null }

describe('SendFormModal', () => {
  it('renders as an accessible dialog that closes on Escape', () => {
    const onClose = vi.fn()
    render(<SendFormModal templates={[{ id: 1, name: 'Intake Form' }]} onClose={onClose} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has a patient search box instead of a patient list, and lists matches with UHID only after typing', async () => {
    const fetchMock = vi.fn(async (url: string) => (url.startsWith('/api/patients/lookup')
      ? new Response(JSON.stringify({ results: [SARO], page: 1, pageSize: 10, hasMore: false }), { status: 200 })
      : new Response('{}', { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    render(<SendFormModal templates={[{ id: 1, name: 'Intake Form' }]} onClose={vi.fn()} />)
    // One <select> only (the form); no patient dropdown and no request before typing.
    expect(screen.getByRole('dialog').querySelectorAll('select')).toHaveLength(1)
    expect(screen.queryByRole('option', { name: /saroja/i })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox', { name: /patient/i }), { target: { value: 'Saro' } })
    const option = await screen.findByRole('option', { name: /saroja devi/i })
    expect(option).toHaveTextContent('UHID UH00000007')
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/patients/lookup?q=Saro'])
  })

  it('starts with the initial patient already chosen', () => {
    render(<SendFormModal templates={[{ id: 1, name: 'Intake Form' }]} onClose={vi.fn()} initialPatient={{ id: 'RD-0007', name: 'Saroja Devi', uhid: 'UH00000007' }} />)
    expect(screen.getByText('Saroja Devi')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /patient/i })).not.toBeInTheDocument()
  })

  it('on success shows a "Form sent" toast whose next step is the intake link', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 3, accessToken: 'tok-123' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const onClose = vi.fn()
    // Like the real callers, onClose unmounts the modal.
    function Harness() {
      const [open, setOpen] = useState(true)
      return open ? <SendFormModal templates={[{ id: 1, name: 'Intake Form' }]} onClose={() => { onClose(); setOpen(false) }} initialPatient={{ id: 'RD-0007', name: 'Saroja Devi', uhid: 'UH00000007' }} /> : null
    }
    render(<Harness />)
    fireEvent.change(screen.getByRole('dialog').querySelector('select')!, { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send Form' }))
    // The intake link stays in the dialog until Done; the toast follows when it closes.
    expect(await screen.findByRole('textbox', { name: 'Intake link' })).toHaveValue(`${window.location.origin}/intake/tok-123`)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Form sent')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Copy link' })).toHaveAttribute('href', '/intake/tok-123')
    expect(fetchMock).toHaveBeenCalledWith('/api/form-submissions', expect.objectContaining({ method: 'POST' }))
  })
})
