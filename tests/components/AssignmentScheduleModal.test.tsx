import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AssignmentScheduleModalTrigger } from '@/components/AssignmentScheduleModal'
import type { DoctorAssignmentRow } from '@/lib/queries/doctor-assignments'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const ASSIGNMENT = {
  id: 42,
  patientId: 'RD-0001',
  providerId: 1,
  visitType: 'outpatient',
  urgency: 'routine',
  reason: 'r/o MI -- internal triage note',
  status: 'pending',
} as unknown as DoctorAssignmentRow

afterEach(() => { vi.unstubAllGlobals() })

describe('AssignmentScheduleModal', () => {
  it('posts only the time slot -- never the visit reason (the server uses the stored one)', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ id: 42 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    render(<AssignmentScheduleModalTrigger assignment={ASSIGNMENT} />)
    fireEvent.click(screen.getByText('Review'))
    fireEvent.change(screen.getByLabelText('Appointment date'), { target: { value: '2026-11-03' } })
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '10:00' } })
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '10:30' } })
    fireEvent.click(screen.getByText('Schedule'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/front-desk/assignments/42/schedule')
    expect(JSON.parse(init!.body as string)).toEqual({ startsAt: '2026-11-03T10:00:00', endsAt: '2026-11-03T10:30:00' })
  })
})
