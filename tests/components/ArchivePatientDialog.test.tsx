import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
import { ArchivePatientDialog } from '@/components/ArchivePatientDialog'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

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
    render(<ArchivePatientDialog target={TARGET} onClose={onClose} onArchived={onArchived} />)
    fireEvent.change(screen.getByLabelText('UHID'), { target: { value: 'uh000000017' } })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Duplicate chart' } })
    fireEvent.click(screen.getByRole('button', { name: /^archive patient$/i }))
    await waitFor(() => expect(onArchived).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/patients/RD-0001/archive')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'Duplicate chart', confirmUhid: 'uh000000017' })
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
    expect(container).toBeEmptyDOMElement()
  })
})
