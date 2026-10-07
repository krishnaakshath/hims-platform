import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { CodePicker } from '@/components/coding/CodePicker'
import type { CodeSearchHit } from '@/lib/queries/code-systems'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const hit = (o: Partial<CodeSearchHit> = {}): CodeSearchHit => ({
  id: 9, kind: 'icd10', code: 'E11.9', display: 'Type 2 diabetes mellitus without complications', selectable: true, version: '2026', isSample: false, ...o,
})
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('CodePicker', () => {
  it('searches after typing and picks with Enter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ codeSystem: { id: 1, version: '2026', isSample: false }, hits: [hit(), hit({ id: 10, code: 'E11.65' })] }))
    vi.stubGlobal('fetch', fetchMock)
    const onPick = vi.fn()
    render(<CodePicker kinds={['icd10', 'snomed']} onDate="2026-10-01" onPick={onPick} />)
    const box = screen.getByRole('combobox', { name: /search codes/i })
    fireEvent.change(box, { target: { value: 'e' } })
    fireEvent.change(box, { target: { value: 'e1' } })
    fireEvent.change(box, { target: { value: 'e11' } })
    await screen.findByRole('option', { name: /E11\.9/ })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/coding/codes?kind=icd10&q=e11&on=2026-10-01')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(box).toHaveAttribute('aria-activedescendant', expect.stringContaining('9'))
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(hit())
  })

  it('says when no code set is loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ codeSystem: null, hits: [] })))
    render(<CodePicker kinds={['icd10']} onDate="2026-10-01" onPick={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox', { name: /search codes/i }), { target: { value: 'e11' } })
    expect(await screen.findByText('No ICD-10 code set loaded')).toBeInTheDocument()
  })

  it('limits the kind select to the allowed kinds and searches the chosen one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ codeSystem: { id: 2, version: 'SAMPLE-SNOMED-0', isSample: true }, hits: [hit({ kind: 'snomed', code: '44054006', isSample: true, version: 'SAMPLE-SNOMED-0' })] }))
    vi.stubGlobal('fetch', fetchMock)
    render(<CodePicker kinds={['icd10', 'snomed']} onDate="2026-10-01" onPick={vi.fn()} />)
    const kind = screen.getByRole('combobox', { name: /code set/i }) as HTMLSelectElement
    expect(Array.from(kind.options).map((o) => o.value)).toEqual(['icd10', 'snomed'])
    fireEvent.change(kind, { target: { value: 'snomed' } })
    fireEvent.change(screen.getByRole('combobox', { name: /search codes/i }), { target: { value: 'diab' } })
    const option = await screen.findByRole('option', { name: /44054006/ })
    expect(option).toHaveTextContent('Sample')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/coding/codes?kind=snomed&q=diab&on=2026-10-01')
  })

  it('a non-selectable header code cannot be picked; Escape closes the list; a server error shows in an alert', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ codeSystem: { id: 1, version: '2026', isSample: false }, hits: [hit({ selectable: false, code: 'E11' })] }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    const onPick = vi.fn()
    render(<CodePicker kinds={['icd10']} onDate="2026-10-01" onPick={onPick} />)
    const box = screen.getByRole('combobox', { name: /search codes/i })
    fireEvent.change(box, { target: { value: 'e11' } })
    const option = await screen.findByRole('option', { name: /E11/ })
    expect(option).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(option)
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.change(box, { target: { value: 'e12' } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Forbidden'))
  })
})
