import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PracticeInfoForm } from '@/components/PracticeInfoForm'
import { PRACTICE_TIMEZONES, DEFAULT_PRACTICE_TIMEZONE, isPracticeTimezone } from '@/lib/practice-timezones'

afterEach(() => { vi.unstubAllGlobals() })

const options = () => Array.from((screen.getByLabelText('Time zone') as HTMLSelectElement).options).map((o) => o.value)

describe('practice time-zone list', () => {
  it('defaults to Asia/Kolkata, offers India-relevant zones and no US zones', () => {
    expect(DEFAULT_PRACTICE_TIMEZONE).toBe('Asia/Kolkata')
    expect(PRACTICE_TIMEZONES[0].value).toBe('Asia/Kolkata')
    const values = PRACTICE_TIMEZONES.map((z) => z.value)
    expect(values).toEqual(expect.arrayContaining(['Asia/Kolkata', 'Asia/Dubai', 'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Colombo']))
    expect(values.some((v) => v.startsWith('America/'))).toBe(false)
    expect(isPracticeTimezone('Asia/Kolkata')).toBe(true)
    expect(isPracticeTimezone('America/Los_Angeles')).toBe(false)
  })
})

describe('PracticeInfoForm', () => {
  it('selects the stored Asia/Kolkata and saves it unchanged (never Los Angeles)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PracticeInfoForm initial={{ practiceName: 'City Hospital', practiceSite: 'Pune', practiceTimezone: 'Asia/Kolkata' }} isAdmin />)
    expect(screen.getByLabelText('Time zone')).toHaveValue('Asia/Kolkata')
    expect(options()).not.toContain('America/Los_Angeles')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.practiceTimezone).toBe('Asia/Kolkata')
  })

  it('defaults to Asia/Kolkata when nothing is stored', () => {
    render(<PracticeInfoForm initial={{ practiceName: null, practiceSite: null, practiceTimezone: null }} isAdmin />)
    expect(screen.getByLabelText('Time zone')).toHaveValue('Asia/Kolkata')
  })

  it('shows a stored legacy zone as-is (marked as not allowed) instead of silently replacing it', () => {
    render(<PracticeInfoForm initial={{ practiceName: 'x', practiceSite: 'y', practiceTimezone: 'America/Los_Angeles' }} isAdmin />)
    expect(screen.getByLabelText('Time zone')).toHaveValue('America/Los_Angeles')
    expect(screen.getByText(/America\/Los_Angeles \(current, not supported\)/)).toBeInTheDocument()
  })

  it('shows the server error text when a save is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Choose a supported hospital time zone.' }), { status: 400 })))
    render(<PracticeInfoForm initial={{ practiceName: 'x', practiceSite: 'y', practiceTimezone: 'America/Los_Angeles' }} isAdmin />)
    fireEvent.click(screen.getByText('Save'))
    expect(await screen.findByText('Choose a supported hospital time zone.')).toBeInTheDocument()
  })
})
