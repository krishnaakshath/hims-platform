import { describe, it, expect, vi, beforeEach } from 'vitest'

const sessionRef = vi.hoisted(() => ({ role: 'crc' as string }))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: sessionRef.role, name: 'Jamie Ruiz' })) }))
const { mockRedirect } = vi.hoisted(() => ({ mockRedirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) }) }))
vi.mock('next/navigation', () => ({ redirect: mockRedirect }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }))

const listAppointmentsInRange = vi.fn<(start: Date, end: Date, providerIds?: number[]) => Promise<never[]>>(async () => [])
vi.mock('@/lib/queries/appointments', () => ({ listAppointmentsInRange }))

const listActiveProviders = vi.fn(async () => [
    { id: 1, name: 'Dr. Rajiv Kunam', colorTag: 'chart-1' },
    { id: 2, name: 'Dr. Elena Bosch', colorTag: 'chart-2' },
  ])
vi.mock('@/lib/queries/providers', () => ({ listActiveProviders }))

const listPatientsWithStatus = vi.fn(async () => [
  { id: 'RD-0001', name: 'Maria Alvarez' },
])
vi.mock('@/lib/queries/patients', () => ({ listPatientsWithStatus }))

// Wave C: the calendar no longer ships the whole patient list to the client;
// `?book=<chart id>` preselects one patient (minimal projection) for the
// New Event modal (the patient page's "Book appointment" quick path).
const getPickedPatient = vi.fn(async (id: string) => (id === 'RD-0001' ? { id: 'RD-0001', name: 'Maria Alvarez', uhid: 'UH1' } : null))
vi.mock('@/lib/queries/search', () => ({ getPickedPatient }))

beforeEach(() => { sessionRef.role = 'crc'; mockRedirect.mockClear() })

describe('/calendar page role gate (admin, crc, pi, frontdesk)', () => {
  for (const role of ['pharmacy', 'billing', 'labs', 'coder', 'collector', 'rcm']) {
    it(`redirects ${role} to / before any query runs`, async () => {
      sessionRef.role = role
      listAppointmentsInRange.mockClear(); listActiveProviders.mockClear(); listPatientsWithStatus.mockClear()
      const { default: CalendarPage } = await import('@/app/(dashboard)/calendar/page')
      await expect(CalendarPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT:/')
      expect(mockRedirect).toHaveBeenCalledWith('/')
      expect(listAppointmentsInRange).not.toHaveBeenCalled()
      expect(listActiveProviders).not.toHaveBeenCalled()
      expect(listPatientsWithStatus).not.toHaveBeenCalled()
    })
  }

  for (const role of ['admin', 'crc', 'pi', 'frontdesk']) {
    it(`renders for ${role}`, async () => {
      sessionRef.role = role
      listAppointmentsInRange.mockClear()
      const { default: CalendarPage } = await import('@/app/(dashboard)/calendar/page')
      await CalendarPage({ searchParams: Promise.resolve({}) })
      expect(mockRedirect).not.toHaveBeenCalled()
      expect(listAppointmentsInRange).toHaveBeenCalledTimes(1)
    })
  }
})

describe('/calendar page', () => {
  it('fetches the week range getViewRange produces when no explicit view is given', async () => {
    listAppointmentsInRange.mockClear()
    const { default: CalendarPage } = await import('@/app/(dashboard)/calendar/page')
    const { getViewRange } = await import('@/lib/calendar-dates')

    await CalendarPage({ searchParams: Promise.resolve({}) })

    const expected = getViewRange('week', new Date())
    expect(listAppointmentsInRange).toHaveBeenCalledTimes(1)
    const [calledStart, calledEnd, calledProviderIds] = listAppointmentsInRange.mock.calls[0]
    // Same calendar-day granularity as getViewRange('week', today) -- exact
    // millisecond equality isn't meaningful across two separate `new Date()`
    // calls a few lines apart, so compare the calendar date instead.
    expect(calledStart.toDateString()).toBe(expected.start.toDateString())
    expect(calledEnd.toDateString()).toBe(expected.end.toDateString())
    expect(calledProviderIds).toBeUndefined() // no providerIds param -> no filter
  })

  it('fetches the exact month range for view=month', async () => {
    listAppointmentsInRange.mockClear()
    const { default: CalendarPage } = await import('@/app/(dashboard)/calendar/page')
    const { getViewRange, parseDateParam } = await import('@/lib/calendar-dates')

    await CalendarPage({ searchParams: Promise.resolve({ view: 'month', date: '2026-09-17' }) })

    const anchor = parseDateParam('2026-09-17')
    const expected = getViewRange('month', anchor)
    const [calledStart, calledEnd] = listAppointmentsInRange.mock.calls[0]
    expect(calledStart.toDateString()).toBe(expected.start.toDateString())
    expect(calledEnd.toDateString()).toBe(expected.end.toDateString())
  })

  it('passes an empty providerIds array (not undefined) when the filter is explicitly "Uncheck All"', async () => {
    listAppointmentsInRange.mockClear()
    const { default: CalendarPage } = await import('@/app/(dashboard)/calendar/page')

    await CalendarPage({ searchParams: Promise.resolve({ providerIds: '' }) })

    const [, , calledProviderIds] = listAppointmentsInRange.mock.calls[0]
    expect(calledProviderIds).toEqual([])
  })

  it('passes the parsed provider id list when specific providers are selected', async () => {
    listAppointmentsInRange.mockClear()
    const { default: CalendarPage } = await import('@/app/(dashboard)/calendar/page')

    await CalendarPage({ searchParams: Promise.resolve({ providerIds: '1,2' }) })

    const [, , calledProviderIds] = listAppointmentsInRange.mock.calls[0]
    expect(calledProviderIds).toEqual([1, 2])
  })
})

describe('/calendar page patient field (Wave C)', () => {
  it('does not load the whole patient list', async () => {
    listPatientsWithStatus.mockClear()
    const { default: CalendarPage } = await import('@/app/(dashboard)/calendar/page')
    await CalendarPage({ searchParams: Promise.resolve({}) })
    expect(listPatientsWithStatus).not.toHaveBeenCalled()
    expect(getPickedPatient).not.toHaveBeenCalled()
  })

  it('preselects the ?book= patient by chart id', async () => {
    getPickedPatient.mockClear()
    const { default: CalendarPage } = await import('@/app/(dashboard)/calendar/page')
    await CalendarPage({ searchParams: Promise.resolve({ book: 'RD-0001' }) })
    expect(getPickedPatient).toHaveBeenCalledWith('RD-0001')
  })

  it('ignores a malformed ?book= value without querying', async () => {
    getPickedPatient.mockClear()
    const { default: CalendarPage } = await import('@/app/(dashboard)/calendar/page')
    await CalendarPage({ searchParams: Promise.resolve({ book: 'x'.repeat(80) }) })
    expect(getPickedPatient).not.toHaveBeenCalled()
  })
})
