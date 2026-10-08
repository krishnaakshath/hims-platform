import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'

afterEach(() => { vi.unstubAllGlobals() })

const ASHA = { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042', gender: 'female', ageYears: 34, phone: '+919812345671' }
const RAVI = { id: 'RD-0002', name: 'Ravi Kumar', uhid: null, gender: 'male', ageYears: 51 }

function page(results: unknown[], hasMore = false, p = 1) {
  return new Response(JSON.stringify({ results, page: p, pageSize: 10, hasMore }), { status: 200 })
}

function Harness({ onChange, initial = null }: { onChange?: (p: PickedPatient | null) => void; initial?: PickedPatient | null }) {
  const [value, setValue] = useState<PickedPatient | null>(initial)
  return <PatientPicker value={value} onChange={(p) => { setValue(p); onChange?.(p) }} />
}

const combobox = () => screen.getByRole('combobox', { name: /patient/i })

describe('PatientPicker', () => {
  it('is a labelled combobox and does not search below 2 characters', async () => {
    const fetchMock = vi.fn(async () => page([]))
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness />)
    expect(combobox()).toHaveAttribute('aria-autocomplete', 'list')
    fireEvent.change(combobox(), { target: { value: 'a' } })
    await new Promise((r) => setTimeout(r, 350))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText(/at least 2 characters/i)).toBeInTheDocument()
  })

  it('searches by what was typed and shows name, UHID, chart id, age and mobile', async () => {
    const fetchMock = vi.fn(async (url: string) => { void url; return page([ASHA, RAVI]) })
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness />)
    fireEvent.change(combobox(), { target: { value: '98123 45671' } })
    const option = await screen.findByRole('option', { name: /asha rao/i })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/patients/lookup?q=98123%2045671')
    expect(option).toHaveTextContent('UH00000042')
    expect(option).toHaveTextContent('RD-0001')
    expect(option).toHaveTextContent('34 y')
    expect(option).toHaveTextContent('+91 98123 45671')
    expect(combobox()).toHaveAttribute('aria-expanded', 'true')
  })

  it('selects with the keyboard (ArrowDown, Enter) and reports a minimal patient', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page([ASHA, RAVI])))
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.change(combobox(), { target: { value: 'ra' } })
    await screen.findByRole('option', { name: /ravi kumar/i })
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' })
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' })
    expect(combobox().getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /ravi kumar/i }).id)
    fireEvent.keyDown(combobox(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith({ id: 'RD-0002', name: 'Ravi Kumar', uhid: null })
    expect(screen.getByText('Ravi Kumar')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('selects with a click; Change clears the selection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page([ASHA])))
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.change(combobox(), { target: { value: 'asha' } })
    fireEvent.click(await screen.findByRole('option', { name: /asha rao/i }))
    expect(onChange).toHaveBeenLastCalledWith({ id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042' })
    fireEvent.click(screen.getByRole('button', { name: /change patient/i }))
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(combobox()).toBeInTheDocument()
  })

  it('shows a preselected patient without searching', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness initial={{ id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042' }} />)
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.getByText(/UH00000042/)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows an alert, not a crash, when the lookup answers non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })))
    render(<Harness />)
    fireEvent.change(combobox(), { target: { value: 'asha' } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/patient search is unavailable/i))
  })

  it('says when nothing matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page([])))
    render(<Harness />)
    fireEvent.change(combobox(), { target: { value: 'zzzz' } })
    expect(await screen.findByText(/no patients match/i)).toBeInTheDocument()
  })

  it('loads the next page on Show more', async () => {
    const fetchMock = vi.fn(async (url: string) => (url.includes('page=2') ? page([RAVI], false, 2) : page([ASHA], true)))
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness />)
    fireEvent.change(combobox(), { target: { value: 'ra' } })
    await screen.findByRole('option', { name: /asha rao/i })
    fireEvent.click(screen.getByRole('button', { name: /show more/i }))
    await screen.findByRole('option', { name: /ravi kumar/i })
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/patients/lookup?q=ra&page=2')
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('closes the list on Escape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page([ASHA])))
    render(<Harness />)
    fireEvent.change(combobox(), { target: { value: 'asha' } })
    await screen.findByRole('option', { name: /asha rao/i })
    fireEvent.keyDown(combobox(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(combobox()).toHaveAttribute('aria-expanded', 'false')
  })
})
