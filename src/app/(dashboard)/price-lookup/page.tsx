import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { TARIFF_LOOKUP_ROLES } from '@/lib/role-policy'
import { todayIsoIn } from '@/lib/india-time'
import { parseId } from '@/lib/http'
import { getService } from '@/lib/queries/tariff'
import { PriceLookupPanel } from '@/components/tariff/PriceLookupPanel'

// Wave B P1-05: the UI for GET /api/tariff/resolve. Lookups carry no PHI and
// are not audited (SP2 plan ruling 8, same as the route).
// Wave G P1-05: ?serviceId= (a global search hit) preselects an active service.
export default async function PriceLookupPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  // Must be the first statement -- see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  if (!TARIFF_LOOKUP_ROLES.includes(session.role)) redirect('/')

  const raw = (await searchParams).serviceId
  const serviceId = typeof raw === 'string' ? parseId(raw) : null
  const found = serviceId !== null ? await getService(serviceId) : null
  const initialService = found && found.isActive
    ? { id: found.id, code: found.code, name: found.name, departmentName: found.departmentName }
    : null

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold text-foreground">Price Lookup</h1>
      <p className="mb-6 text-sm text-muted-foreground">Find the current tariff for a service on a given date: the full rate card by room, ward, department and payer, and the price that applies to one case.</p>
      <PriceLookupPanel today={todayIsoIn('Asia/Kolkata')} initialService={initialService} />
    </div>
  )
}
