import { redirect } from 'next/navigation'
import { Tags } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { countServices, listServicesWithCurrentPrices } from '@/lib/queries/tariff'
import { listDepartments } from '@/lib/queries/departments'
import { todayIsoIn } from '@/lib/india-time'
import { SERVICE_CATEGORIES, type ServiceCategory } from '@/lib/tariff/validation'
import { ServicesTable } from '@/components/tariff/ServicesTable'

const PAGE_SIZE = 50

export default async function TariffsPage({ searchParams }: {
  searchParams: Promise<{ q?: string; departmentId?: string; category?: string; inactive?: string; page?: string }>
}) {
  const session = await requireSessionOrRedirect()
  // Tariff management is admin + billing only (crc/frontdesk use the lookup API, not these pages).
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) redirect('/')

  const sp = await searchParams
  const q = typeof sp.q === 'string' ? sp.q.trim().slice(0, 100) : ''
  const departmentId = typeof sp.departmentId === 'string' && /^\d{1,9}$/.test(sp.departmentId) ? Number(sp.departmentId) : undefined
  const category = SERVICE_CATEGORIES.find((c) => c.code === sp.category)?.code as ServiceCategory | undefined
  const inactive = sp.inactive === '1'

  const filter = { q: q || undefined, departmentId, category, includeInactive: inactive }
  const [total, departments] = await Promise.all([countServices(filter), listDepartments({ activeOnly: true })])
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const requested = typeof sp.page === 'string' && /^\d{1,6}$/.test(sp.page) ? Number(sp.page) : 1
  const page = Math.min(Math.max(requested, 1), lastPage)
  const services = await listServicesWithCurrentPrices({ ...filter, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }, todayIsoIn())

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
          <Tags className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Tariffs</h1>
          <p className="text-sm text-muted-foreground">Service catalogue and current prices. Open a service to manage its rate versions.</p>
        </div>
      </div>
      <ServicesTable
        services={services.map((s) => ({
          id: s.id, code: s.code, name: s.name, departmentId: s.departmentId, departmentName: s.departmentName,
          category: s.category, hsnSac: s.hsnSac, gstRateBp: s.gstRateBp, isActive: s.isActive,
          basePaise: s.basePaise, departmentPaise: s.departmentPaise,
          requiresPreauth: s.requiresPreauth, maxQuantity: s.maxQuantity, // SP4
        }))}
        departments={departments.map((d) => ({ id: d.id, code: d.code, name: d.name }))}
        filters={{ q: q || undefined, departmentId: departmentId ? String(departmentId) : undefined, category, inactive: inactive ? '1' : undefined }}
        pagination={{ page, pageSize: PAGE_SIZE, total }}
      />
    </div>
  )
}
