import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { TARIFF_LOOKUP_ROLES } from '@/lib/role-policy'
import { todayIsoIn } from '@/lib/india-time'
import { PriceLookupPanel } from '@/components/tariff/PriceLookupPanel'

// Wave B P1-05: the UI for GET /api/tariff/resolve. Lookups carry no PHI and
// are not audited (SP2 plan ruling 8, same as the route).
export default async function PriceLookupPage() {
  // Must be the first statement -- see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  if (!TARIFF_LOOKUP_ROLES.includes(session.role)) redirect('/')

  return (
    <div className="max-w-xl">
      <h1 className="mb-1 text-2xl font-bold text-foreground">Price Lookup</h1>
      <p className="mb-6 text-sm text-muted-foreground">Find the current tariff for a service on a given date, optionally for a room category.</p>
      <PriceLookupPanel today={todayIsoIn('Asia/Kolkata')} />
    </div>
  )
}
