import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { verhoeffCheckDigit } from '@/lib/india/verhoeff'
import { AddClientModal } from '@/components/AddClientModal'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const VALID_AADHAAR = '23456789012' + verhoeffCheckDigit('23456789012')

describe('AddClientModal', () => {
  it('renders as an accessible dialog that closes on Escape', () => {
    const onClose = vi.fn()
    render(<AddClientModal onClose={onClose} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('still requires a name and DOB before Save is enabled', () => {
    render(<AddClientModal onClose={vi.fn()} />)
    expect(screen.getByText('Save')).toBeDisabled()
  })

  describe('registration flow', () => {
    let fetchMock: ReturnType<typeof vi.fn>
    let patientsResponse: () => Response
    beforeEach(() => {
      push.mockClear()
      patientsResponse = () => new Response(JSON.stringify({ id: 7, uhid: 'UH-0001' }), { status: 201 })
      fetchMock = vi.fn(async (url: string) => {
        if (url === '/api/payers') return new Response('[]', { status: 200 })
        return patientsResponse()
      })
      vi.stubGlobal('fetch', fetchMock)
    })
    afterEach(() => vi.unstubAllGlobals())

    const patientCalls = () => fetchMock.mock.calls.filter((c) => c[0] === '/api/patients')
    function fillBase(dob = '1990-05-01') {
      fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Asha Rao' } })
      fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: dob } })
      fireEvent.change(screen.getByLabelText('Gender'), { target: { value: 'female' } })
      fireEvent.change(screen.getByLabelText('Address line 1'), { target: { value: '12 MG Road' } })
      fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Bengaluru' } })
      fireEvent.change(screen.getByLabelText('District'), { target: { value: 'Bengaluru Urban' } })
      fireEvent.change(screen.getByLabelText('State / UT'), { target: { value: 'IN-KA' } })
      fireEvent.change(screen.getByLabelText('PIN code'), { target: { value: '560001' } })
      // ABHA: patient has none
      fireEvent.click(screen.getByLabelText('ABHA not available'))
      fireEvent.change(screen.getByLabelText('Reason ABHA is not available'), { target: { value: 'not_created' } })
    }

    it('shows a checksum error and does not POST for a bad Aadhaar', async () => {
      render(<AddClientModal onClose={vi.fn()} />)
      fillBase()
      fireEvent.change(screen.getByLabelText('Aadhaar number'), { target: { value: '234567890125' } })
      fireEvent.click(screen.getByLabelText('Patient consents to recording their Aadhaar number'))
      fireEvent.click(screen.getByText('Save'))
      expect(await screen.findByText('Enter a valid 12-digit Aadhaar number')).toBeInTheDocument()
      expect(patientCalls()).toHaveLength(0)
    })

    it('shows the guardian error for a minor', async () => {
      render(<AddClientModal onClose={vi.fn()} />)
      fillBase('2024-01-01')
      fireEvent.click(screen.getByLabelText('Patient does not provide Aadhaar'))
      fireEvent.change(screen.getByLabelText('Reason for no Aadhaar'), { target: { value: 'minor_no_aadhaar' } })
      fireEvent.click(screen.getByText('Save'))
      expect(await screen.findByText(/guardian contact is required/i)).toBeInTheDocument()
      expect(patientCalls()).toHaveLength(0)
    })

    it('posts the full payload, then navigates and clears Aadhaar from the request path only', async () => {
      const onClose = vi.fn()
      render(<AddClientModal onClose={onClose} />)
      fillBase()
      fireEvent.change(screen.getByLabelText('Aadhaar number'), { target: { value: VALID_AADHAAR } })
      fireEvent.click(screen.getByLabelText('Patient consents to recording their Aadhaar number'))
      fireEvent.click(screen.getByText('Save'))
      await waitFor(() => expect(push).toHaveBeenCalledWith('/patients/7'))
      const [url, init] = patientCalls()[0]
      expect(url).toBe('/api/patients')
      const body = JSON.parse(init.body)
      expect(body.aadhaar).toEqual({ status: 'provided', number: VALID_AADHAAR, consent: true })
      expect(body.abha).toEqual({ status: 'unavailable', reason: 'not_created' })
      expect(onClose).toHaveBeenCalled()
    })

    it('clears the Aadhaar field after a failed submit and maps server field errors', async () => {
      patientsResponse = () => new Response(JSON.stringify({ error: 'Invalid registration', details: { formErrors: [], fieldErrors: { pinCode: ['Enter a valid 6-digit PIN code'] } } }), { status: 400 })
      render(<AddClientModal onClose={vi.fn()} />)
      fillBase()
      fireEvent.change(screen.getByLabelText('Aadhaar number'), { target: { value: VALID_AADHAAR } })
      fireEvent.click(screen.getByLabelText('Patient consents to recording their Aadhaar number'))
      fireEvent.click(screen.getByText('Save'))
      await waitFor(() => expect(patientCalls()).toHaveLength(1))
      expect(await screen.findByText('Enter a valid 6-digit PIN code')).toBeInTheDocument()
      expect((screen.getByLabelText('Aadhaar number') as HTMLInputElement).value).toBe('')
    })

    it('shows a server message on 409', async () => {
      patientsResponse = () => new Response(JSON.stringify({ error: 'This ABHA number is already registered to another patient' }), { status: 409 })
      render(<AddClientModal onClose={vi.fn()} />)
      fillBase()
      fireEvent.click(screen.getByLabelText('Patient does not provide Aadhaar'))
      fireEvent.change(screen.getByLabelText('Reason for no Aadhaar'), { target: { value: 'patient_declined' } })
      fireEvent.click(screen.getByText('Save'))
      expect(await screen.findByText(/already registered/i)).toBeInTheDocument()
    })
  })
})
