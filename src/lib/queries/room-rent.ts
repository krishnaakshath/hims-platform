// SP4: room rent posted per IST census day from the admission's room history (plan ruling 7).
// On demand and idempotent: a day that already has a live room-rent line is skipped, and the
// partial unique index charge_lines_room_rent_day_unique makes a racing post a no-op.
import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissionTransfers, admissions, chargeLines, roomCategories, rooms } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { planRoomRentDays, type StayRoom } from '@/lib/billing/room-rent'
import { resolvePrice } from '@/lib/tariff/resolve'
import { getBillingSettings } from './billing-settings'
import { loadChargeContext, lockPatientBilling } from './charge-capture'
import { loadPricingContext } from './tariff'

export type RoomRentSkip = { date: string; reason: 'no_rate' | 'no_room' }

export async function postRoomRent(
  admissionId: number, session: Session, opts: { throughDate?: string; now?: Date } = {},
): Promise<{ ok: true; posted: number; skipped: RoomRentSkip[] } | { ok: false; error: 'not_found' | 'service_not_configured' }> {
  const now = opts.now ?? new Date()
  const db = getDb()
  const [pre] = await db.select({ patientId: admissions.patientId }).from(admissions).where(eq(admissions.id, admissionId)).limit(1)
  if (!pre) return { ok: false, error: 'not_found' }
  const serviceId = (await getBillingSettings()).roomRentServiceId
  if (serviceId === null) return { ok: false, error: 'service_not_configured' }
  const pricing = await loadPricingContext(serviceId)
  if (!pricing.service) return { ok: false, error: 'service_not_configured' }
  const service = pricing.service

  return db.transaction(async (tx) => {
    await lockPatientBilling(tx, pre.patientId)
    const context = await loadChargeContext(tx, { admissionId })
    const [adm] = await tx.select({ admittedAt: admissions.admittedAt, dischargedAt: admissions.dischargedAt, currentRoomId: admissions.currentRoomId })
      .from(admissions).where(eq(admissions.id, admissionId)).limit(1)
    if (!context || !adm) return { ok: false as const, error: 'not_found' as const }

    const transfers = await tx.select({ at: admissionTransfers.transferredAt, fromRoomId: admissionTransfers.fromRoomId, toRoomId: admissionTransfers.toRoomId })
      .from(admissionTransfers).where(eq(admissionTransfers.admissionId, admissionId)).orderBy(asc(admissionTransfers.transferredAt), asc(admissionTransfers.id))
    const initialRoomId = transfers.length > 0 ? transfers[0].fromRoomId : adm.currentRoomId
    const roomIds = [...new Set([initialRoomId, ...transfers.map((t) => t.toRoomId)].filter((id): id is number => id !== null))]
    const roomRows = roomIds.length === 0 ? [] : await tx.select({ id: rooms.id, ward: rooms.ward, code: roomCategories.code })
      .from(rooms).leftJoin(roomCategories, eq(roomCategories.id, rooms.roomCategoryId)).where(inArray(rooms.id, roomIds))
    const stayRoom = new Map<number, StayRoom>(roomRows.map((r) => [r.id, { roomId: r.id, ward: r.ward, roomCategoryCode: r.code ?? null }]))
    const roomOf = (id: number | null) => (id === null ? null : stayRoom.get(id) ?? null)

    const planned = planRoomRentDays({
      admittedAt: adm.admittedAt, dischargedAt: adm.dischargedAt, now, initialRoom: roomOf(initialRoomId),
      transfers: transfers.flatMap((t) => { const toRoom = roomOf(t.toRoomId); return toRoom ? [{ at: t.at, toRoom }] : [] }),
    }).filter((d) => opts.throughDate === undefined || d.date <= opts.throughDate)

    const live = new Set((await tx.select({ d: chargeLines.serviceDate }).from(chargeLines).where(and(
      eq(chargeLines.admissionId, admissionId), eq(chargeLines.source, 'room_rent'), ne(chargeLines.status, 'void'),
    ))).map((r) => r.d))

    let posted = 0
    const skipped: RoomRentSkip[] = []
    for (const day of planned) {
      if (live.has(day.date)) continue
      if (day.room === null) { skipped.push({ date: day.date, reason: 'no_room' }); continue }
      // Room rent follows the patient's primary payer for pricing (ruling 6).
      const price = resolvePrice({
        serviceId, payerId: context.primaryPayerId ?? undefined, departmentId: context.departmentId ?? undefined,
        roomCategory: day.room.roomCategoryCode ?? undefined, ward: day.room.ward, onDate: day.date,
      }, pricing)
      if (!price.ok) { skipped.push({ date: day.date, reason: 'no_rate' }); continue }
      const inserted = await tx.insert(chargeLines).values({
        patientId: context.patientId,
        encounterId: context.encounterId,
        admissionId,
        source: 'room_rent',
        serviceId,
        itemCode: service.code,
        itemName: service.name,
        serviceCategory: 'room_rent',
        departmentId: service.departmentId,
        orderingProviderId: context.orderingProviderId,
        serviceDate: day.date,
        quantity: 1,
        unitPricePaise: price.amountPaise,
        priceSource: price.scope,
        tariffRateId: price.rateId,
        taxablePaise: price.amountPaise,
        gstRateBp: service.gstRateBp,
        hsnSac: service.hsnSac,
        payerId: context.primaryPayerId,
        createdByName: session.name,
        createdByUserId: session.userId,
      }).onConflictDoNothing().returning({ id: chargeLines.id })
      posted += inserted.length
    }

    await logAudit(session, 'billing: posted room rent', context.patientId, `admission=${admissionId} days=${posted} skipped=${skipped.length}`, tx)
    return { ok: true as const, posted, skipped }
  })
}
