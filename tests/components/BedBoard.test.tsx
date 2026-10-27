// WS3 T4: the bed board's occupied-bed panel (spec 3.2 item 12): UHID (never the chart id), days
// stayed, bed tariff, and Transfer / Discharge / MAR / Charges per role; the transfer dialog's
// ward-gender override on a 422.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { BedBoard, type BoardRoom } from '@/components/BedBoard'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

const CHART_ID = 'RD-CHART-0042'
const OCCUPIED: BoardRoom = {
  id: 21, ward: 'General Ward (Female)', roomNumber: '102', bedNumber: 'B', status: 'occupied', blockedReason: null,
  occupantName: 'Asha Rao', occupantPatientId: CHART_ID, attendingProviderName: 'Dr. Meera Iyer', admittedAt: new Date('2026-10-21T04:30:00Z'),
  admissionId: 7, occupantUhid: 'UH00000042', occupantGender: 'female', genderRestriction: 'female', roomCategoryName: 'General ward',
  bedTariffPaise: 1_500_00, daysStayed: 3, wardGenderOverride: false,
}
const FREE_MALE: BoardRoom = {
  id: 22, ward: 'General Ward (Male)', roomNumber: '101', bedNumber: 'A', status: 'available', blockedReason: null,
  occupantName: null, occupantPatientId: null, attendingProviderName: null, admittedAt: null,
  admissionId: null, occupantUhid: null, occupantGender: null, genderRestriction: 'male', roomCategoryName: 'General ward',
  bedTariffPaise: 1_500_00, daysStayed: null, wardGenderOverride: false,
}
const AVAILABLE = [{ id: 22, ward: 'General Ward (Male)', roomNumber: '101', bedNumber: 'A' }]

const ALL_FLAGS = { canManageFacilities: true, canBlock: true, canAdmit: true, canTransfer: true, canDischarge: true, canManageMedications: true, canCaptureCharges: true }
const FRONTDESK = { canManageFacilities: true, canBlock: false, canAdmit: true, canTransfer: true, canDischarge: false, canManageMedications: false, canCaptureCharges: false }

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function openOccupied(flags: typeof ALL_FLAGS, room: BoardRoom = OCCUPIED) {
  render(<BedBoard rooms={[room, FREE_MALE]} availableRooms={AVAILABLE} {...flags} />)
  fireEvent.click(screen.getByRole('button', { name: /Room 102 · Bed B/ }))
  return screen.getByRole('dialog')
}

describe('BedBoard occupied-bed panel', () => {
  it('shows the UHID, days stayed and the bed tariff, never the chart id', () => {
    const panel = openOccupied(ALL_FLAGS)
    expect(within(panel).getByText(/UH00000042/)).toBeInTheDocument()
    expect(within(panel).getByText(/Day 3/)).toBeInTheDocument()
    expect(within(panel).getByText(/₹1,500\/day/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(CHART_ID)
  })

  it('shows days stayed and the tariff on the card itself', () => {
    render(<BedBoard rooms={[OCCUPIED]} availableRooms={[]} {...ALL_FLAGS} />)
    const card = screen.getByRole('button', { name: /Room 102 · Bed B/ })
    expect(card).toHaveTextContent('Day 3')
    expect(card).toHaveTextContent('₹1,500/day')
  })

  it('offers Transfer, Discharge, MAR and Charges to a role with every right; Charges goes to charge capture', () => {
    const panel = openOccupied(ALL_FLAGS)
    expect(within(panel).getByRole('button', { name: 'Transfer' })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Discharge' })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'MAR' })).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'Charges' })).toHaveAttribute('href', '/billing/capture?admissionId=7')
  })

  it('frontdesk sees Transfer but not Discharge, MAR or Charges', () => {
    const panel = openOccupied(FRONTDESK)
    expect(within(panel).getByRole('button', { name: 'Transfer' })).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Discharge' })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'MAR' })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('link', { name: 'Charges' })).not.toBeInTheDocument()
  })

  it('marks a bed held under a ward-gender override', () => {
    render(<BedBoard rooms={[{ ...OCCUPIED, wardGenderOverride: true }]} availableRooms={[]} {...ALL_FLAGS} />)
    expect(screen.getByRole('button', { name: /Room 102 · Bed B/ })).toHaveTextContent('Gender override')
  })

  it('Transfer opens the transfer dialog; a ward-gender conflict asks for an override reason and resends with it', async () => {
    const replies = [
      { status: 422, body: { error: 'This bed is in a ward for the other gender. Give a reason to override, or choose another bed.', code: 'ward_gender_conflict', conflict: 'opposite_sex' } },
      { status: 200, body: { ok: true } },
    ]
    const fetchMock = vi.fn(async () => { const r = replies.shift()!; return new Response(JSON.stringify(r.body), { status: r.status }) })
    vi.stubGlobal('fetch', fetchMock)
    const panel = openOccupied(ALL_FLAGS)
    fireEvent.click(within(panel).getByRole('button', { name: 'Transfer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Transfer Patient' })
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'New room' }), { target: { value: '22' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Reason' }), { target: { value: 'Needs isolation' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer' }))
    const override = await within(dialog).findByRole('textbox', { name: 'Override reason' })
    expect(within(dialog).getByRole('button', { name: 'Transfer' })).toBeDisabled()
    fireEvent.change(override, { target: { value: 'Only isolation bed free tonight' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer' }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(calls[1][0]).toBe('/api/inpatient/admissions/7/transfer')
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ toRoomId: 22, reason: 'Needs isolation', wardGenderOverrideReason: 'Only isolation bed free tonight' })
  })
})

describe('BedBoard bed gender setting', () => {
  it('lets an admin set a free bed\'s gender restriction', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<BedBoard rooms={[FREE_MALE]} availableRooms={[]} {...ALL_FLAGS} canSetBedGender />)
    fireEvent.click(screen.getByRole('button', { name: /Room 101 · Bed A/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Bed gender' }), { target: { value: 'mixed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save bed gender' }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]
    expect(url).toBe('/api/inpatient/rooms/22')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ genderRestriction: null })
  })

  it('offers no bed gender setting without the master-data role', () => {
    render(<BedBoard rooms={[FREE_MALE]} availableRooms={[]} {...FRONTDESK} canSetBedGender={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Room 101 · Bed A/ }))
    expect(screen.queryByRole('combobox', { name: 'Bed gender' })).not.toBeInTheDocument()
  })
})
