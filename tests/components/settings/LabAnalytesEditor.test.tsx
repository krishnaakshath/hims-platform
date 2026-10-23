import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LabAnalytesEditor } from '@/components/settings/LabAnalytesEditor'

// WS4 T8 fix round 1: a mistyped number must block the save, never silently clear the bound.
const HGB = {
  id: 1, code: 'HGB', name: 'Haemoglobin', unit: 'g/dL', valueType: 'numeric', decimals: 1, loincCode: null, isActive: true,
  options: null, abnormalOptions: null, criticalOptions: null,
  ranges: [{ sex: 'female', ageMinDays: 6570, ageMaxDays: null, normalLow: 12, normalHigh: 15.5, criticalLow: 7, criticalHigh: 20, displayText: null }],
}
const LOADED = { test: { id: 9, name: 'CBC', code: 'CBC-DIFF' }, analytes: [HGB] }

afterEach(() => vi.unstubAllGlobals())

function setup() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(LOADED), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  render(<LabAnalytesEditor labTestId={9} testName="CBC" onClose={() => {}} />)
  return fetchMock
}

describe('LabAnalytesEditor', () => {
  it('a mistyped critical limit blocks the save with an error naming the analyte and field, and sends nothing', async () => {
    const fetchMock = setup()
    const critLow = await screen.findByLabelText('Critical low')
    expect(critLow).toHaveValue('7')
    fireEvent.change(critLow, { target: { value: '6,5' } })
    fireEvent.click(screen.getByRole('button', { name: /save analytes/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('HGB: Critical low (range 1) must be a number'))
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the initial GET
  })

  it('mistyped decimals or age are refused the same way', async () => {
    const fetchMock = setup()
    fireEvent.change(await screen.findByLabelText('Decimals'), { target: { value: 'one' } })
    fireEvent.click(screen.getByRole('button', { name: /save analytes/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('HGB: Decimals must be a number'))
    fireEvent.change(screen.getByLabelText('Decimals'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Age from (days)'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: /save analytes/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('HGB: Age from (days) (range 1) must be a number'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('valid input saves; an emptied bound is sent as null', async () => {
    const fetchMock = setup()
    fireEvent.change(await screen.findByLabelText('Critical high'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /save analytes/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(init.method).toBe('PUT')
    const body = JSON.parse(String(init.body))
    expect(body.analytes[0].ranges[0]).toMatchObject({ criticalLow: 7, criticalHigh: null, normalLow: 12 })
  })
})
