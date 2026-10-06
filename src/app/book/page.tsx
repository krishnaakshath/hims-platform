import { listActiveProviders } from '@/lib/queries/providers'
import { listAppointmentsInRange } from '@/lib/queries/appointments'
import { PublicBookingForm } from '@/components/PublicBookingForm'
import { BrandLogo } from '@/components/BrandLogo'

// Deliberately outside the `(dashboard)` route group -- this page must only
// ever inherit the root layout (no session check, no app chrome). Do not add
// requireSession()/requireSessionOrRedirect() here or in PublicBookingForm;
// this is the one genuinely unauthenticated, public-facing page in the app,
// reachable by a cold visitor from the practice's public website with no
// account and no staff-sent token. See spec §1.
// Reads live availability from the database on every request: it must never be
// prerendered at build time (a fresh deployment has no database yet, and a
// prerendered booking window would be frozen at the build date).
export const dynamic = 'force-dynamic'

export default async function PublicBookingPage() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const windowEnd = new Date(today)
  windowEnd.setDate(windowEnd.getDate() + 90)

  const [providerRows, appointmentRows] = await Promise.all([
    listActiveProviders(),
    listAppointmentsInRange(today, windowEnd),
  ])

  // Narrow at the SERVER boundary, not just in a TypeScript type -- props
  // passed to a Client Component are serialized whole into the RSC flight
  // payload embedded in this page's HTML, regardless of a narrower prop
  // type (`Pick<>` is compile-time only and strips nothing at runtime).
  // `listAppointmentsInRange()`'s full rows carry patient names, patient
  // IDs, and visit reasons -- real PHI -- that must never reach this
  // genuinely unauthenticated page. Pre-aggregate to a per-provider count
  // instead of ever sending a per-appointment row across the boundary; the
  // widget's "already booked" hint only ever needed a count, never the rows.
  const providerAppointmentCounts: Record<number, number> = {}
  for (const appointment of appointmentRows) {
    providerAppointmentCounts[appointment.providerId] =
      (providerAppointmentCounts[appointment.providerId] ?? 0) + 1
  }

  // Same treatment for providers -- lower stakes (name/specialty, not PHI)
  // but still explicitly narrowed to plain literal objects containing only
  // the fields the form renders, so nothing wider than that ever crosses
  // the server/client boundary on this page.
  const providers = providerRows.map((p) => ({ id: p.id, name: p.name, specialty: p.specialty }))

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-secondary/40 px-4 py-10">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-gradient-to-b from-primary/10 to-transparent"
        aria-hidden="true"
      />
      <div className="relative w-full max-w-lg">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <BrandLogo className="text-xl font-semibold tracking-tight text-foreground" />
          <p className="text-sm text-muted-foreground">Request an Appointment</p>
        </div>

        <div className="rounded-2xl border border-primary/10 bg-card p-7 shadow-md">
          <div className="mb-6 text-center">
            <h1 className="text-xl font-bold text-foreground">Tell us a bit about your visit</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Submitting this form sends a request to our team — it does not book a confirmed
              appointment. We&apos;ll reach out to confirm a time.
            </p>
          </div>
          <PublicBookingForm providers={providers} providerAppointmentCounts={providerAppointmentCounts} />
        </div>
      </div>
    </div>
  )
}
