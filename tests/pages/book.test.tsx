import { describe, it, expect, vi } from 'vitest'
import { isValidElement, type ReactElement } from 'react'
import { PublicBookingForm } from '@/components/PublicBookingForm'

// Realistic fixture PHI -- the exact category of data the final
// whole-branch review's Critical finding showed leaking into the raw HTML
// of an unauthenticated request to /book: a real patient name, a real
// patient ID in this app's RD-#### format, a visit reason, and clinical
// notes (both of which can reveal clinical-trial participation).
const FIXTURE_PATIENT_NAME = 'Extremely Fake Regression Patient'
const FIXTURE_PATIENT_ID = 'RD-0019'
const FIXTURE_VISIT_REASON = 'Randomization visit'
const FIXTURE_NOTES = 'Consent review note -- must never leave the server'

vi.mock('@/lib/queries/providers', () => ({
  listActiveProviders: vi.fn(async () => [
    { id: 1, name: 'Dr. Rajiv Kunam', credentials: 'MD', specialty: 'Cardiology', colorTag: 'chart-1', isActive: true, createdAt: new Date() },
  ]),
}))

vi.mock('@/lib/queries/appointments', () => ({
  listAppointmentsInRange: vi.fn(async () => [
    {
      id: 1,
      patientId: FIXTURE_PATIENT_ID,
      patientName: FIXTURE_PATIENT_NAME,
      providerId: 1,
      providerName: 'Dr. Rajiv Kunam',
      providerColorTag: 'chart-1',
      startsAt: new Date('2026-10-05T10:00:00Z'),
      endsAt: new Date('2026-10-05T10:30:00Z'),
      visitReason: FIXTURE_VISIT_REASON,
      status: 'scheduled',
      notes: FIXTURE_NOTES,
    },
  ]),
}))

/**
 * Walks a React element tree -- as returned by calling an async Server
 * Component directly, before Next.js ever renders or serializes it -- to
 * find the first element of a given component type. Used below to inspect
 * exactly what props src/app/book/page.tsx hands across the Server ->
 * Client Component boundary, since that prop object (not its declared
 * TypeScript type) is what Next.js actually serializes into the RSC flight
 * payload embedded in the page's HTML.
 */
function findElement(node: unknown, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type)
      if (found) return found
    }
    return null
  }
  if (isValidElement(node)) {
    if (node.type === type) return node
    return findElement((node.props as { children?: unknown }).children, type)
  }
  return null
}

describe('/book page (public, unauthenticated widget)', () => {
  it('never passes per-appointment PHI (patient names/IDs/visit reasons/notes) across the Client Component boundary', async () => {
    const { default: PublicBookingPage } = await import('@/app/book/page')
    const jsx = await PublicBookingPage()

    const formElement = findElement(jsx, PublicBookingForm)
    expect(formElement).toBeTruthy()

    // A `Pick<>` TypeScript type does not strip anything at runtime -- the
    // only reliable regression guard is the actual prop object this page
    // builds. Assert the exact allowed shape (nothing wider ever sneaks in)
    // AND that none of a realistic appointment row's PHI is reachable
    // anywhere inside it, matching the reviewer's own live-curl method but
    // at the props boundary so it runs in every CI test suite, not just a
    // manual dev-server check.
    const props = formElement!.props as Record<string, unknown>
    expect(Object.keys(props).sort()).toEqual(['providerAppointmentCounts', 'providers'])

    const serialized = JSON.stringify(props)
    expect(serialized).not.toContain(FIXTURE_PATIENT_NAME)
    expect(serialized).not.toContain(FIXTURE_PATIENT_ID)
    expect(serialized).not.toContain(FIXTURE_VISIT_REASON)
    expect(serialized).not.toContain(FIXTURE_NOTES)
    expect(serialized).not.toMatch(/RD-\d+/)

    // Positive shape check -- the safe, pre-aggregated replacement for the
    // per-appointment rows this page used to pass.
    expect(props.providerAppointmentCounts).toEqual({ 1: 1 })
    expect(props.providers).toEqual([{ id: 1, name: 'Dr. Rajiv Kunam', specialty: 'Cardiology' }])
  })
})
