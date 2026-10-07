import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { getService, listPackageItems, listRatesForService, listRoomCategories, listServices } from '@/lib/queries/tariff'
import { listPayers } from '@/lib/queries/payers'
import { listDepartments } from '@/lib/queries/departments'
import { todayIsoIn } from '@/lib/india-time'
import { SERVICE_CATEGORIES } from '@/lib/tariff/validation'
import { AddRateModal } from '@/components/tariff/AddRateModal'
import { RateVersionsTable } from '@/components/tariff/RateVersionsTable'
import { PackageItemsEditor } from '@/components/tariff/PackageItemsEditor'

export default async function ServiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) redirect('/')

  const { id: rawId } = await params
  // Plain digits within int4 only; anything else is not a service.
  if (!/^\d{1,9}$/.test(rawId) || Number(rawId) < 1) notFound()
  const id = Number(rawId)

  const service = await getService(id)
  if (!service) notFound()

  const today = todayIsoIn()
  const isPackage = service.category === 'package'
  const [rates, departments, payers, roomCategories, packageItems, allServices] = await Promise.all([
    listRatesForService(id),
    listDepartments({ activeOnly: true }),
    listPayers(),
    listRoomCategories(false),
    isPackage ? listPackageItems(id) : Promise.resolve([]),
    isPackage ? listServices({ limit: 1000 }) : Promise.resolve([]),
  ])
  const categoryLabel = SERVICE_CATEGORIES.find((c) => c.code === service.category)?.label ?? service.category

  return (
    <div className="space-y-8">
      <div>
        <Link href="/tariffs" className="text-sm text-primary underline-offset-2 hover:underline">Back to tariffs</Link>
        <h1 className="mt-2 text-2xl font-bold text-foreground">{service.name}</h1>
        <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
          <div><dt className="text-xs uppercase tracking-wide text-muted-foreground">Code</dt><dd className="font-mono">{service.code}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-muted-foreground">Department</dt><dd>{service.departmentName}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-muted-foreground">Category</dt><dd>{categoryLabel}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-muted-foreground">HSN/SAC</dt><dd className="font-mono">{service.hsnSac}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-muted-foreground">GST</dt><dd>{service.gstRateBp / 100}%</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-muted-foreground">Status</dt><dd>{service.isActive ? 'Active' : 'Inactive'}</dd></div>
        </dl>
      </div>

      <section aria-labelledby="rates-h" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="rates-h" className="text-lg font-semibold">Rate versions</h2>
          <AddRateModal
            serviceId={service.id}
            serviceCategory={service.category}
            today={today}
            departments={departments.map((d) => ({ id: d.id, code: d.code, name: d.name }))}
            payers={payers.map((p) => ({ id: p.id, name: p.name }))}
            roomCategories={roomCategories.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
          />
        </div>
        <RateVersionsTable
          today={today}
          rates={rates.map((r) => ({
            id: r.id, scope: r.scope, departmentName: r.departmentName, payerName: r.payerName,
            roomCategoryCode: r.roomCategoryCode, ward: r.ward, amountPaise: r.amountPaise,
            validFrom: r.validFrom, validTo: r.validTo, deactivated: r.deactivatedAt !== null,
          }))}
        />
      </section>

      {isPackage && (
        <PackageItemsEditor
          packageServiceId={service.id}
          items={packageItems.map((i) => ({ itemServiceId: i.itemServiceId, code: i.code, name: i.name, quantity: i.quantity }))}
          services={allServices.map((s) => ({ id: s.id, code: s.code, name: s.name, category: s.category }))}
        />
      )}
    </div>
  )
}
