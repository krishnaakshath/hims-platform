// WS4 T9: per-analyte result entry with live automatic flags; single-value tests keep the old form.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { EnterLabResultModal } from '@/components/EnterLabResultModal'
import type { AnalyteDef } from '@/lib/labs/analytes'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  refresh.mockClear()
})

const ADULT = 18 * 365
const HGB: AnalyteDef = {
  id: 11, code: 'HGB', name: 'Haemoglobin', unit: 'g/dL', valueType: 'numeric', decimals: 1, options: null, abnormalOptions: null, criticalOptions: null,
  ranges: [
    { sex: 'male', ageMinDays: ADULT, ageMaxDays: null, normalLow: 13.5, normalHigh: 17.5, criticalLow: 7, criticalHigh: 20, displayText: null },
    { sex: 'female', ageMinDays: ADULT, ageMaxDays: null, normalLow: 12, normalHigh: 15.5, criticalLow: 7, criticalHigh: 20, displayText: null },
  ],
}
const WBC: AnalyteDef = {
  id: 12, code: 'WBC', name: 'Total leucocyte count', unit: '10^3/µL', valueType: 'numeric', decimals: 1, options: null, abnormalOptions: null, criticalOptions: null,
  ranges: [{ sex: 'any', ageMinDays: ADULT, ageMaxDays: null, normalLow: 4, normalHigh: 11, criticalLow: 2, criticalHigh: 30, displayText: null }],
}
const SMEAR: AnalyteDef = {
  id: 13, code: 'SMEAR', name: 'Peripheral smear', unit: null, valueType: 'text', decimals: null, options: null, abnormalOptions: null, criticalOptions: null, ranges: [],
}

const renderModal = (analytes: AnalyteDef[]) => render(
  <EnterLabResultModal orderId={7} testName="Complete Blood Count" defaultUnit={null} defaultReferenceRange={null} category="lab" attachments={[]}
    analytes={analytes} patientSex="female" ageDays={30 * 365} onClose={vi.fn()} />,
)
const optionsOf = (select: HTMLElement) => Array.from((select as HTMLSelectElement).options).map((o) => o.value).filter(Boolean)

describe('EnterLabResultModal — per analyte', () => {
  it('shows one row per analyte with unit and the patient\'s range, and no single-value field', () => {
    renderModal([HGB, WBC])
    expect(screen.queryByLabelText('Result value')).toBeNull()
    const row = screen.getByRole('row', { name: /Haemoglobin/ })
    expect(within(row).getByText('12.0-15.5 g/dL')).toBeInTheDocument()
    expect(screen.getByLabelText('Value for Total leucocyte count')).toBeInTheDocument()
  })

  it('typing 6.5 for Hb shows "Critical low" and the flag select offers only Critical', () => {
    renderModal([HGB, WBC])
    fireEvent.change(screen.getByLabelText('Value for Haemoglobin'), { target: { value: '6.5' } })
    const row = screen.getByRole('row', { name: /Haemoglobin/ })
    expect(within(row).getByText('Critical low')).toBeInTheDocument()
    expect(optionsOf(screen.getByLabelText('Flag for Haemoglobin'))).toEqual(['critical'])
    fireEvent.change(screen.getByLabelText('Value for Haemoglobin'), { target: { value: '11.0' } })
    expect(within(row).getByText('Low')).toBeInTheDocument()
    expect(optionsOf(screen.getByLabelText('Flag for Haemoglobin'))).toEqual(['abnormal', 'critical'])
  })

  it('submits { analytes } with an override only for a raised flag, which needs a reason', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderModal([HGB, WBC])
    fireEvent.change(screen.getByLabelText('Value for Haemoglobin'), { target: { value: '6.5' } })
    fireEvent.change(screen.getByLabelText('Value for Total leucocyte count'), { target: { value: '7.2' } })
    const save = screen.getByRole('button', { name: 'Save result' })
    expect(save).not.toBeDisabled()
    fireEvent.change(screen.getByLabelText('Flag for Total leucocyte count'), { target: { value: 'abnormal' } })
    expect(save).toBeDisabled() // a raised flag needs a reason
    fireEvent.change(screen.getByLabelText('Reason for the Total leucocyte count flag'), { target: { value: 'Atypical cells on smear' } })
    expect(save).not.toBeDisabled()
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Phoned to the ward' } })
    fireEvent.click(save)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/lab-orders/7/result')
    expect(JSON.parse(init.body as string)).toEqual({
      analytes: [
        { analyteId: 11, value: '6.5' },
        { analyteId: 12, value: '7.2', flagOverride: { flag: 'abnormal', reason: 'Atypical cells on smear' } },
      ],
      notes: 'Phoned to the ward',
    })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('a row with no automatic flag requires a flag and a reason before saving', () => {
    renderModal([SMEAR])
    fireEvent.change(screen.getByLabelText('Value for Peripheral smear'), { target: { value: 'Normocytic normochromic' } })
    const row = screen.getByRole('row', { name: /Peripheral smear/ })
    expect(within(row).getByText('No automatic flag')).toBeInTheDocument()
    expect(optionsOf(screen.getByLabelText('Flag for Peripheral smear'))).toEqual(['normal', 'abnormal', 'critical'])
    const save = screen.getByRole('button', { name: 'Save result' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Flag for Peripheral smear'), { target: { value: 'normal' } })
    fireEvent.change(screen.getByLabelText('Reason for the Peripheral smear flag'), { target: { value: 'Smear reviewed' } })
    expect(save).not.toBeDisabled()
  })

  it('amending prefills each analyte value and its manual flag', () => {
    render(
      <EnterLabResultModal orderId={7} testName="CBC" defaultUnit={null} defaultReferenceRange={null} category="lab" attachments={[]}
        analytes={[HGB, WBC]} patientSex="female" ageDays={30 * 365} onClose={vi.fn()}
        initial={{ value: '2 analytes', unit: null, flag: 'abnormal', analytes: [
          { analyteId: 11, code: 'HGB', name: 'Haemoglobin', value: '13.0', unit: 'g/dL', referenceRange: '12.0-15.5 g/dL', flag: 'normal', interpretation: 'N', flagSource: 'auto', flagReason: null, loincCode: '718-7' },
          { analyteId: 12, code: 'WBC', name: 'Total leucocyte count', value: '7.0', unit: '10^3/µL', referenceRange: '4.0-11.0 10^3/µL', flag: 'abnormal', interpretation: 'A', flagSource: 'manual', flagReason: 'Atypical cells on smear', loincCode: '6690-2' },
        ] }} />,
    )
    expect(screen.getByText(/Amend result/)).toBeInTheDocument()
    expect((screen.getByLabelText('Value for Haemoglobin') as HTMLInputElement).value).toBe('13.0')
    expect((screen.getByLabelText('Flag for Total leucocyte count') as HTMLSelectElement).value).toBe('abnormal')
    expect((screen.getByLabelText('Reason for the Total leucocyte count flag') as HTMLInputElement).value).toBe('Atypical cells on smear')
  })

  it('a test without analytes keeps the single-value form', () => {
    render(<EnterLabResultModal orderId={7} testName="Glucose" defaultUnit="mg/dL" defaultReferenceRange="70-99" category="lab" attachments={[]} onClose={vi.fn()} />)
    expect(screen.getByLabelText('Result value')).toBeInTheDocument()
    expect(screen.getByLabelText('Flag')).toBeInTheDocument()
  })
})
