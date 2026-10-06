import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfirmBookingRequestModal } from '@/components/ConfirmBookingRequestModal'
import type { BookingRequestRow } from '@/lib/queries/booking-requests'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

function requestWithReason(reason: string) {
  return {
    id: 5, requesterName: 'Morgan Lee', reason, preferredProviderId: null,
    preferredDateRangeStart: '2026-11-01', preferredDateRangeEnd: '2026-11-10',
  } as unknown as BookingRequestRow
}

describe('ConfirmBookingRequestModal visit reason', () => {
  it('prefills a long multi-line public request reason normalized to at most 140 chars', () => {
    // Public booking requests allow up to 2000 chars; the confirm route caps visitReason at 140.
    const reason = 'I have had\n\nheadaches   for weeks. ' + 'More detail. '.repeat(40)
    render(<ConfirmBookingRequestModal request={requestWithReason(reason)} providers={[{ id: 1, name: 'Dr. Test' }]} onClose={vi.fn()} />)
    const input = screen.getByLabelText('Visit reason') as HTMLInputElement
    expect(input.value.startsWith('I have had headaches for weeks. More detail.')).toBe(true)
    expect(Array.from(input.value)).toHaveLength(140)
    expect(input.value.endsWith('…')).toBe(true)
    expect(input).toHaveAttribute('maxLength', '140')
  })

  it('prefills a short reason unchanged', () => {
    render(<ConfirmBookingRequestModal request={requestWithReason('New patient intake')} providers={[{ id: 1, name: 'Dr. Test' }]} onClose={vi.fn()} />)
    expect(screen.getByLabelText('Visit reason')).toHaveValue('New patient intake')
  })
})
