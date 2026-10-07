import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { listRatesForServices, listRoomCategories, listRoomsWithCategory, listServices } from '@/lib/queries/tariff'
import { todayIsoIn } from '@/lib/india-time'
import { RoomCategoriesPanel } from '@/components/tariff/RoomCategoriesPanel'
import { RoomTariffMatrix } from '@/components/tariff/RoomTariffMatrix'

export default async function RoomCategoriesPage() {
  const session = await requireSessionOrRedirect()
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) redirect('/')

  const today = todayIsoIn()
  const [categories, rooms, roomServices] = await Promise.all([
    listRoomCategories(true),
    listRoomsWithCategory(),
    listServices({ category: 'room_rent', limit: 200 }),
  ])
  const rates = await listRatesForServices(roomServices.map((s) => s.id)) // one query, not one per service

  return (
    <div className="space-y-8">
      <div>
        <Link href="/tariffs" className="text-sm text-primary underline-offset-2 hover:underline">Back to tariffs</Link>
        <h1 className="mt-2 text-2xl font-bold text-foreground">Room categories and ward tariffs</h1>
        <p className="text-sm text-muted-foreground">Group rooms into categories, then price room rent per day by category or ward.</p>
      </div>
      <RoomCategoriesPanel
        categories={categories.map((c) => ({ id: c.id, code: c.code, name: c.name, isActive: c.isActive }))}
        rooms={rooms.map((r) => ({ id: r.id, ward: r.ward, roomNumber: r.roomNumber, bedNumber: r.bedNumber, roomCategoryId: r.roomCategoryId }))}
      />
      <section aria-labelledby="matrix-h" className="space-y-3">
        <h2 id="matrix-h" className="text-lg font-semibold">Current per-day room rates</h2>
        <p className="text-sm text-muted-foreground">Read-only. Open a service to add or revise its rates.</p>
        <RoomTariffMatrix
          today={today}
          services={roomServices.map((s) => ({ id: s.id, code: s.code, name: s.name }))}
          categories={categories.filter((c) => c.isActive).map((c) => ({ id: c.id, code: c.code, name: c.name }))}
          rates={rates.map((r) => ({
            serviceId: r.serviceId, scope: r.scope, roomCategoryId: r.roomCategoryId, ward: r.ward,
            amountPaise: r.amountPaise, validFrom: r.validFrom, validTo: r.validTo, deactivated: r.deactivatedAt !== null,
          }))}
        />
      </section>
    </div>
  )
}
