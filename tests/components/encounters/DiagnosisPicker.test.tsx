import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('@/lib/client-fetch', () => ({ sendJson: vi.fn() }))
import { sendJson } from '@/lib/client-fetch'
import { DiagnosisPicker } from '@/components/encounters/DiagnosisPicker'

const hit = { id: 77, kind: 'icd10', code: 'R50.9', display: 'Fever, unspecified', selectable: true, version: '2019', isSample: false }
const fetchMock = vi.fn()

beforeEach(() => {
  refresh.mockReset()
  vi.mocked(sendJson).mockReset().mockResolvedValue({ ok: true, status: 201, data: { diagnosis: { id: 1 } } })
  fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ codeSystem: { id: 1, kind: 'icd10', version: '2019', isSample: false }, hits: [hit] }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('DiagnosisPicker', () => {
  it('typing "fev" searches the ICD-10 code set and shows the WHO attribution', async () => {
    render(<DiagnosisPicker encounterId={5} onDate="2026-10-01" />)
    expect(screen.getByText('WHO ICD-10 (2019)')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: /search icd-10/i }), { target: { value: 'fev' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toMatch(/^\/api\/coding\/codes\?/)
    const params = new URL(url, 'http://x').searchParams
    expect(params.get('kind')).toBe('icd10')
    expect(params.get('q')).toBe('fev')
    expect(await screen.findByText('Fever, unspecified')).toBeInTheDocument()
  })

  it('picking a code posts it with the chosen type and refreshes the page', async () => {
    render(<DiagnosisPicker encounterId={5} onDate="2026-10-01" />)
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'primary' } })
    fireEvent.click(screen.getByLabelText(/add to problem list/i))
    fireEvent.change(screen.getByRole('combobox', { name: /search icd-10/i }), { target: { value: 'fev' } })
    fireEvent.click(await screen.findByText('Fever, unspecified'))
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith('/api/encounters/5/diagnoses', 'POST', { codeId: 77, diagnosisType: 'primary', onProblemList: true }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('a typed diagnosis is posted as free text', async () => {
    render(<DiagnosisPicker encounterId={5} onDate="2026-10-01" />)
    fireEvent.change(screen.getByLabelText(/or type a diagnosis/i), { target: { value: ' Viral fever ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add as free text' }))
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith('/api/encounters/5/diagnoses', 'POST', { text: 'Viral fever', diagnosisType: 'secondary', onProblemList: false }))
  })

  it('shows the server error when the add is refused', async () => {
    vi.mocked(sendJson).mockResolvedValue({ ok: false, status: 409, error: 'This visit already has a primary diagnosis.' })
    render(<DiagnosisPicker encounterId={5} onDate="2026-10-01" />)
    fireEvent.change(screen.getByLabelText(/or type a diagnosis/i), { target: { value: 'Viral fever' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add as free text' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This visit already has a primary diagnosis.')
    expect(refresh).not.toHaveBeenCalled()
  })
})
