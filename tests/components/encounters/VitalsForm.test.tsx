import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/lib/client-fetch', () => ({ sendJson: vi.fn() }))
import { sendJson } from '@/lib/client-fetch'
import { VitalsForm, fahrenheitToCelsius } from '@/components/encounters/VitalsForm'
import { ConsultForm } from '@/components/encounters/ConsultForm'

const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => { vi.mocked(sendJson).mockReset().mockResolvedValue({ ok: true, status: 200, data: {} }) })

describe('VitalsForm', () => {
  it('shows a live BMI and flag chips', () => {
    render(<VitalsForm encounterId={5} />)
    expect(screen.getByTestId('bmi')).toHaveTextContent('BMI: n/a')
    type(/Weight/, '70'); type(/Height/, '175')
    expect(screen.getByTestId('bmi')).toHaveTextContent('BMI: 22.9')
    type(/Systolic/, '150'); type(/Diastolic/, '95')
    expect(screen.getByText('BP high')).toBeInTheDocument()
  })

  it('converts a Fahrenheit entry to Celsius before posting, with pain score and notes', async () => {
    render(<VitalsForm encounterId={5} />)
    fireEvent.click(screen.getByRole('button', { name: '°F' }))
    type(/Temperature/, '100.4'); type(/Pain score/, '4'); type(/Notes/, ' seated ')
    fireEvent.click(screen.getByRole('button', { name: 'Record vitals' }))
    await waitFor(() => expect(sendJson).toHaveBeenCalledTimes(1))
    expect(sendJson).toHaveBeenCalledWith('/api/encounters/5/vitals', 'POST', { tempC: 38, painScore: 4, notes: 'seated' })
    expect(await screen.findByText('Recorded')).toBeInTheDocument()
  })

  it('does not post an empty or invalid set and shows why', () => {
    render(<VitalsForm encounterId={5} />)
    fireEvent.click(screen.getByRole('button', { name: 'Record vitals' }))
    expect(screen.getByRole('alert')).toHaveTextContent('at least one')
    type(/SpO2/, '101')
    fireEvent.click(screen.getByRole('button', { name: 'Record vitals' }))
    expect(sendJson).not.toHaveBeenCalled()
  })

  it('shows the server error', async () => {
    vi.mocked(sendJson).mockResolvedValue({ ok: false, status: 409, error: 'Visit is closed' })
    render(<VitalsForm encounterId={5} />)
    type(/Pulse/, '70')
    fireEvent.click(screen.getByRole('button', { name: 'Record vitals' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Visit is closed')
  })

  it('fahrenheitToCelsius rounds to one decimal', () => {
    expect(fahrenheitToCelsius(98.6)).toBe(37)
    expect(fahrenheitToCelsius(101)).toBe(38.3)
  })
})

describe('ConsultForm', () => {
  it('saves one field on blur only when it changed, then shows Saved', async () => {
    render(<ConsultForm encounterId={9} initial={{ advice: 'rest' }} />)
    const cc = screen.getByLabelText('Chief complaint')
    fireEvent.blur(cc)
    expect(sendJson).not.toHaveBeenCalled()
    fireEvent.change(cc, { target: { value: ' fever ' } })
    fireEvent.blur(cc)
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith('/api/encounters/9/consult', 'PUT', { chiefComplaint: 'fever' }))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    fireEvent.blur(cc)
    expect(sendJson).toHaveBeenCalledTimes(1)
  })

  it('clearing a field sends null; a failure shows an alert', async () => {
    vi.mocked(sendJson).mockResolvedValue({ ok: false, status: 409, error: 'Visit is closed' })
    render(<ConsultForm encounterId={9} initial={{ advice: 'rest' }} />)
    const advice = screen.getByLabelText('Advice')
    fireEvent.change(advice, { target: { value: '' } })
    fireEvent.blur(advice)
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith('/api/encounters/9/consult', 'PUT', { advice: null }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Visit is closed')
  })
})
