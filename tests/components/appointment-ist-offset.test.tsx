import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NewEventModal } from '@/components/NewEventModal'
import { ConfirmBookingRequestModal } from '@/components/ConfirmBookingRequestModal'
import { AssignmentScheduleModalTrigger } from '@/components/AssignmentScheduleModal'
import { MedicationAdministrationPanel } from '@/components/MedicationAdministrationPanel'
import type { BookingRequestRow } from '@/lib/queries/booking-requests'
import type { DoctorAssignmentRow } from '@/lib/queries/doctor-assignments'

// Wave A (P0-03): every appointment-creating UI sends the IST wall-clock time
// with an explicit +05:30 offset, exactly like the SP3 follow-up booking.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

type FetchMock = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>
function stubFetch(): FetchMock {
  const m = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify([]), { status: 200 }))
  vi.stubGlobal('fetch', m)
  return m
}
const sentBody = (m: FetchMock, i = 0) => JSON.parse(m.mock.calls[i][1]!.body as string)

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('appointment-creating UIs send +05:30', () => {
  it('NewEventModal', async () => {
    const fetchMock = stubFetch()
    render(<NewEventModal patients={[{ id: 'RD-0001', name: 'Asha' }]} providers={[{ id: 7, name: 'Dr. Rao' }]} defaultDate="2026-11-03" onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Patient'), { target: { value: 'RD-0001' } })
    fireEvent.change(screen.getByLabelText('Doctor'), { target: { value: '7' } })
    fireEvent.change(screen.getByLabelText('Start time (IST)'), { target: { value: '09:00' } })
    fireEvent.change(screen.getByLabelText('End time (IST)'), { target: { value: '09:30' } })
    fireEvent.change(screen.getByPlaceholderText('Visit reason'), { target: { value: 'Fever' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(sentBody(fetchMock)).toMatchObject({ startsAt: '2026-11-03T09:00:00+05:30', endsAt: '2026-11-03T09:30:00+05:30' })
  })

  it('ConfirmBookingRequestModal', async () => {
    const fetchMock = stubFetch()
    const request = { id: 5, requesterName: 'Morgan', reason: 'Checkup', preferredProviderId: 7, preferredDateRangeStart: '2026-11-01', preferredDateRangeEnd: '2026-11-10' } as unknown as BookingRequestRow
    render(<ConfirmBookingRequestModal request={request} providers={[{ id: 7, name: 'Dr. Rao' }]} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Patient ID'), { target: { value: 'RD-0001' } })
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '14:15' } })
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '14:45' } })
    fireEvent.click(screen.getByText('Confirm'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(sentBody(fetchMock)).toMatchObject({ startsAt: '2026-11-01T14:15:00+05:30', endsAt: '2026-11-01T14:45:00+05:30' })
  })

  it('AssignmentScheduleModal defaults to the IST date and sends +05:30', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-02T20:00:00Z')) // 01:30 IST on 3 Nov
    const fetchMock = stubFetch()
    const assignment = { id: 42, patientId: 'RD-0001', providerId: 1, status: 'pending', reason: 'x' } as unknown as DoctorAssignmentRow
    render(<AssignmentScheduleModalTrigger assignment={assignment} />)
    fireEvent.click(screen.getByText('Review'))
    expect(screen.getByLabelText('Appointment date')).toHaveValue('2026-11-03')
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '10:00' } })
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '10:30' } })
    fireEvent.click(screen.getByText('Schedule'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(sentBody(fetchMock)).toEqual({ startsAt: '2026-11-03T10:00:00+05:30', endsAt: '2026-11-03T10:30:00+05:30' })
  })

  it('MedicationAdministrationPanel schedules a dose at IST wall-clock time', async () => {
    const fetchMock = stubFetch()
    render(<MedicationAdministrationPanel admissionId={3} onClose={vi.fn()} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Medication name'), { target: { value: 'Ceftriaxone' } })
    fireEvent.change(screen.getByLabelText('Dose'), { target: { value: '1 g' } })
    fireEvent.change(screen.getByLabelText('Scheduled date'), { target: { value: '2026-11-03' } })
    fireEvent.change(screen.getByLabelText('Scheduled time'), { target: { value: '06:00' } })
    fireEvent.click(screen.getByText('Add medication'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(sentBody(fetchMock, 1)).toMatchObject({ scheduledFor: '2026-11-03T06:00:00+05:30' })
  })
})
