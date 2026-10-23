import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SendFormModal } from '@/components/SendFormModal'

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
})
