// SP2 tariff query layer: every DB read/write for the service catalogue, effective-dated rates,
// room categories, packages and CSV import commits. Pricing decisions live in the pure
// resolver (src/lib/tariff/resolve.ts); this module only loads rows and writes transactions.
//
// Rules enforced here:
// - Wards are stored NORMALISED (normalizeWard) in every write path, because the DB exclusion
//   `tariff_rates_no_overlap` compares ward text exactly.
// - Multi-statement writes (revise = close + insert, package item replacement, imports) run in
//   ONE transaction. When the caller passes `audit`, the audit row is written inside that same
//   transaction, so it commits or rolls back with the change it records.
// - DB errors propagate unchanged (callers map 23P01/23505 via src/lib/db-errors.ts).
import { getDb } from '@/db/client'
import {
  departments, payers, roomCategories, rooms, serviceCatalog, servicePackageItems, tariffRates,
  type RoomCategory, type ServiceCatalogRow, type TariffRateRow,
} from '@/db/schema'
import { and, asc, desc, eq, getTableColumns, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { normalizeWard, resolvePrice, type ServiceForPricing, type TariffRateCandidate } from '@/lib/tariff/resolve'
import { findOverlap, planRevision, type DatedRate } from '@/lib/tariff/versions'
import {
  IS_PACKAGE_ITEM_MESSAGE, PACKAGE_CHANGED_MESSAGE, PACKAGE_HAS_ITEMS_MESSAGE,
} from '@/lib/tariff/validation'
import type {
  PackageItemsInput, RateCreateInput, RateRevisionInput, ServiceCategory, ServiceCreateInput, ServiceUpdateInput,
} from '@/lib/tariff/validation'
import type { ImportLookups, ServiceImportRow } from '@/lib/tariff/import'

type Db = ReturnType<typeof getDb>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Exec = Db | Tx

/** Optional audit entry written inside the write's own transaction (`logAudit(session, action, null)`). */
export interface TariffAudit { session: Session; action: string }

export interface ServiceRow extends ServiceCatalogRow { departmentCode: string; departmentName: string }
export interface RateRow extends TariffRateRow { payerName: string | null; departmentName: string | null; roomCategoryCode: string | null }

export class TariffOverlapError extends Error {
  readonly conflictingRateId: number | null
  constructor(conflictingRateId: number | null) {
    super('Overlaps an existing rate for the same service and scope')
    this.name = 'TariffOverlapError'
    this.conflictingRateId = conflictingRateId
  }
}

/** A write that would nest packages or strand package items; `message` is fixed text, safe to show. */
export class TariffPackageIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TariffPackageIntegrityError'
  }
}

// ---------- pure mapping ----------

export function toRateCandidate(row: RateRow): TariffRateCandidate {
  return {
    id: row.id, serviceId: row.serviceId, scope: row.scope, departmentId: row.departmentId, payerId: row.payerId,
    roomCategoryCode: row.roomCategoryCode, ward: row.ward, amountPaise: row.amountPaise,
    validFrom: row.validFrom, validTo: row.validTo, deactivated: row.deactivatedAt !== null,
  }
}

export function toDatedRate(row: TariffRateRow): DatedRate {
  return {
    id: row.id, serviceId: row.serviceId, scope: row.scope, departmentId: row.departmentId, payerId: row.payerId,
    roomCategoryId: row.roomCategoryId, ward: row.ward, validFrom: row.validFrom, validTo: row.validTo,
    deactivated: row.deactivatedAt !== null,
  }
}

/** Plain-language problem with a package's item list, or null when it is acceptable. */
export function packageItemsProblem(pkg: ServiceRow, items: PackageItemsInput['items'], servicesById: Map<number, ServiceRow>): string | null {
  if (pkg.category !== 'package') return `${pkg.code} is not a package`
  for (const it of items) {
    if (it.serviceId === pkg.id) return 'A package cannot include itself'
    const s = servicesById.get(it.serviceId)
    if (!s) return `Unknown service #${it.serviceId}`
    if (s.category === 'package') return `${s.code} is a package; packages cannot be nested`
    if (!s.isActive) return `${s.code} is inactive`
  }
  return null
}

// ---------- helpers ----------

const wardOrNull = (w: string | null | undefined): string | null => (w == null ? null : normalizeWard(w))
const likeEscape = (s: string) => s.replace(/[\\%_]/g, '\\$&')

async function inTx<T>(audit: TariffAudit | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    const result = await fn(tx)
    if (audit && result !== null && result !== false) await logAudit(audit.session, audit.action, null, null, tx)
    return result
  })
}

const serviceSelect = (e: Exec) =>
  e.select({ ...getTableColumns(serviceCatalog), departmentCode: departments.code, departmentName: departments.name })
    .from(serviceCatalog).innerJoin(departments, eq(serviceCatalog.departmentId, departments.id))

const rateSelect = (e: Exec) =>
  e.select({ ...getTableColumns(tariffRates), payerName: payers.name, departmentName: departments.name, roomCategoryCode: roomCategories.code })
    .from(tariffRates)
    .leftJoin(payers, eq(tariffRates.payerId, payers.id))
    .leftJoin(departments, eq(tariffRates.departmentId, departments.id))
    .leftJoin(roomCategories, eq(tariffRates.roomCategoryId, roomCategories.id))

async function serviceById(e: Exec, id: number): Promise<ServiceRow | null> {
  const [row] = await serviceSelect(e).where(eq(serviceCatalog.id, id)).limit(1)
  return row ?? null
}

async function rateById(e: Exec, id: number): Promise<RateRow | null> {
  const [row] = await rateSelect(e).where(eq(tariffRates.id, id)).limit(1)
  return row ?? null
}

/**
 * Serialises writes per service (rates, package items) so the app overlap check is reliable.
 * Lock order everywhere: service row(s) first, ascending id, then rate rows.
 */
async function lockService(tx: Tx, serviceId: number): Promise<void> {
  const [row] = await tx.select({ id: serviceCatalog.id }).from(serviceCatalog).where(eq(serviceCatalog.id, serviceId)).for('update')
  if (!row) throw new Error('Service not found')
}

/**
 * Lock several services in one statement, in ascending id order, so two multi-service writers
 * (or an import and a single-service write) cannot deadlock. Missing ids are left to the FK.
 */
async function lockServices(tx: Tx, serviceIds: number[]): Promise<void> {
  const ids = [...new Set(serviceIds)]
  if (ids.length === 0) return
  await tx.select({ id: serviceCatalog.id }).from(serviceCatalog).where(inArray(serviceCatalog.id, ids)).orderBy(asc(serviceCatalog.id)).for('update')
}

async function liveRates(e: Exec, serviceId: number): Promise<TariffRateRow[]> {
  return e.select().from(tariffRates).where(and(eq(tariffRates.serviceId, serviceId), isNull(tariffRates.deactivatedAt)))
}

// ---------- services ----------

export interface ServiceListOptions {
  q?: string
  departmentId?: number
  category?: ServiceCategory
  includeInactive?: boolean
  limit?: number
  /** Rows to skip (code order), for paging. */
  offset?: number
}

function serviceWhere(opts: ServiceListOptions): SQL | undefined {
  const where: SQL[] = []
  const q = opts.q?.trim()
  if (q) {
    const term = likeEscape(q)
    where.push(or(ilike(serviceCatalog.code, `${term}%`), ilike(serviceCatalog.name, `%${term}%`))!)
  }
  if (opts.departmentId !== undefined) where.push(eq(serviceCatalog.departmentId, opts.departmentId))
  if (opts.category !== undefined) where.push(eq(serviceCatalog.category, opts.category))
  if (!opts.includeInactive) where.push(eq(serviceCatalog.isActive, true))
  return and(...where)
}

export async function listServices(opts: ServiceListOptions = {}): Promise<ServiceRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000)
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0)
  return serviceSelect(getDb()).where(serviceWhere(opts)).orderBy(asc(serviceCatalog.code), asc(serviceCatalog.id)).limit(limit).offset(offset)
}

/** How many services match the same filters as `listServices` (ignores limit/offset). */
export async function countServices(opts: ServiceListOptions = {}): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(serviceCatalog).where(serviceWhere(opts))
  return row?.n ?? 0
}

/**
 * Listed services plus their generic (no room category / ward) base and own-department prices on
 * `onDate`. One rates query for all listed ids; resolution happens in memory with `resolvePrice`.
 */
export async function listServicesWithCurrentPrices(
  opts: ServiceListOptions,
  onDate: string,
): Promise<(ServiceRow & { basePaise: number | null; departmentPaise: number | null })[]> {
  const services = await listServices(opts)
  if (services.length === 0) return []
  const rows = await rateSelect(getDb()).where(and(
    inArray(tariffRates.serviceId, services.map((s) => s.id)),
    isNull(tariffRates.deactivatedAt),
  ))
  const byService = new Map<number, TariffRateCandidate[]>()
  for (const r of rows) {
    const list = byService.get(r.serviceId) ?? []
    list.push(toRateCandidate(r))
    byService.set(r.serviceId, list)
  }
  return services.map((s) => {
    const rates = byService.get(s.id) ?? []
    // Display price list: show what the rate rows say even for an inactive service.
    const service: ServiceForPricing = { ...s, isActive: true }
    const priceIn = (scope: 'base' | 'department'): number | null => {
      const res = resolvePrice({ serviceId: s.id, onDate }, { service, rates: rates.filter((r) => r.scope === scope) })
      return res.ok ? res.amountPaise : null
    }
    return { ...s, basePaise: priceIn('base'), departmentPaise: priceIn('department') }
  })
}

export async function getService(id: number): Promise<ServiceRow | null> {
  return serviceById(getDb(), id)
}

export async function getServiceByCode(code: string): Promise<ServiceRow | null> {
  const [row] = await serviceSelect(getDb()).where(eq(serviceCatalog.code, code)).limit(1)
  return row ?? null
}

export async function createService(input: ServiceCreateInput, audit?: TariffAudit): Promise<ServiceRow> {
  return inTx(audit, async (tx) => {
    const [row] = await tx.insert(serviceCatalog).values({
      code: input.code, name: input.name, departmentId: input.departmentId, category: input.category,
      hsnSac: input.hsnSac, gstRateBp: input.gstRateBp,
    }).returning({ id: serviceCatalog.id })
    return (await serviceById(tx, row.id))!
  })
}

/**
 * Throws TariffPackageIntegrityError when a category change would leave a non-package with items,
 * or make a package of a service that is itself an item. Callers hold the service lock(s).
 */
async function assertCategoryChangesAllowed(tx: Tx, changes: { id: number; from: ServiceCategory; to: ServiceCategory }[]): Promise<void> {
  const leaving = changes.filter((c) => c.from === 'package' && c.to !== 'package').map((c) => c.id)
  const joining = changes.filter((c) => c.from !== 'package' && c.to === 'package').map((c) => c.id)
  if (leaving.length > 0) {
    const [hit] = await tx.select({ id: servicePackageItems.id }).from(servicePackageItems).where(inArray(servicePackageItems.packageServiceId, leaving)).limit(1)
    if (hit) throw new TariffPackageIntegrityError(PACKAGE_HAS_ITEMS_MESSAGE)
  }
  if (joining.length > 0) {
    const [hit] = await tx.select({ id: servicePackageItems.id }).from(servicePackageItems).where(inArray(servicePackageItems.itemServiceId, joining)).limit(1)
    if (hit) throw new TariffPackageIntegrityError(IS_PACKAGE_ITEM_MESSAGE)
  }
}

export async function updateService(id: number, patch: ServiceUpdateInput, audit?: TariffAudit): Promise<ServiceRow | null> {
  return inTx(audit, async (tx) => {
    if (patch.category !== undefined) {
      // Lock the service (same lock as package-item writes) so the item check cannot race.
      const [cur] = await tx.select({ category: serviceCatalog.category }).from(serviceCatalog).where(eq(serviceCatalog.id, id)).for('update')
      if (!cur) return null
      await assertCategoryChangesAllowed(tx, [{ id, from: cur.category, to: patch.category }])
    }
    const [row] = await tx.update(serviceCatalog).set({ ...patch, updatedAt: new Date() })
      .where(eq(serviceCatalog.id, id)).returning({ id: serviceCatalog.id })
    return row ? serviceById(tx, row.id) : null
  })
}

// ---------- rates ----------

const RATE_ORDER = [
  asc(tariffRates.scope), asc(tariffRates.departmentId), asc(tariffRates.payerId), asc(tariffRates.roomCategoryId),
  asc(tariffRates.ward), desc(tariffRates.validFrom), desc(tariffRates.id),
]

export async function listRatesForService(serviceId: number): Promise<RateRow[]> {
  return rateSelect(getDb()).where(eq(tariffRates.serviceId, serviceId)).orderBy(...RATE_ORDER)
}

/** Every rate of several services in one query: grouped by service id, then the per-service order. */
export async function listRatesForServices(serviceIds: number[]): Promise<RateRow[]> {
  if (serviceIds.length === 0) return []
  return rateSelect(getDb()).where(inArray(tariffRates.serviceId, serviceIds)).orderBy(asc(tariffRates.serviceId), ...RATE_ORDER)
}

export async function getRate(id: number): Promise<RateRow | null> {
  return rateById(getDb(), id)
}

export async function createRate(input: RateCreateInput, byName: string, audit?: TariffAudit): Promise<RateRow> {
  return inTx(audit, async (tx) => {
    await lockService(tx, input.serviceId)
    const candidate: DatedRate = {
      serviceId: input.serviceId, scope: input.scope, departmentId: input.departmentId ?? null, payerId: input.payerId ?? null,
      roomCategoryId: input.roomCategoryId ?? null, ward: wardOrNull(input.ward),
      validFrom: input.validFrom, validTo: input.validTo ?? null,
    }
    const conflict = findOverlap(candidate, (await liveRates(tx, input.serviceId)).map(toDatedRate))
    if (conflict) throw new TariffOverlapError(conflict.id ?? null)
    // The DB exclusion `tariff_rates_no_overlap` is the backstop for anything the check above misses.
    const [row] = await tx.insert(tariffRates).values({
      serviceId: candidate.serviceId, scope: candidate.scope, departmentId: candidate.departmentId, payerId: candidate.payerId,
      roomCategoryId: candidate.roomCategoryId, ward: candidate.ward, amountPaise: input.amountPaise,
      validFrom: candidate.validFrom, validTo: candidate.validTo, createdByName: byName,
    }).returning({ id: tariffRates.id })
    return (await rateById(tx, row.id))!
  })
}

/** Close the current version the day before `effectiveFrom` and insert the new amount, atomically. */
export async function reviseRate(
  id: number,
  input: RateRevisionInput,
  byName: string,
  audit?: TariffAudit,
): Promise<{ closed: RateRow; created: RateRow }> {
  return inTx(audit, async (tx) => {
    const [peek] = await tx.select({ serviceId: tariffRates.serviceId }).from(tariffRates).where(eq(tariffRates.id, id))
    if (!peek) throw new Error('Rate not found')
    // Lock order: service, then rate (same as createRate's service lock).
    await lockService(tx, peek.serviceId)
    const [current] = await tx.select().from(tariffRates).where(eq(tariffRates.id, id)).for('update')
    const plan = planRevision({ ...toDatedRate(current), id: current.id, amountPaise: current.amountPaise, deactivated: current.deactivatedAt !== null }, input)
    if (!plan.ok) throw new Error(plan.error)

    const insert = { ...plan.insert, ward: wardOrNull(plan.insert.ward) }
    const others = (await liveRates(tx, current.serviceId)).filter((r) => r.id !== current.id).map(toDatedRate)
    const conflict = findOverlap(insert, others)
    if (conflict) throw new TariffOverlapError(conflict.id ?? null)

    await tx.update(tariffRates).set({ validTo: plan.close.validTo }).where(eq(tariffRates.id, plan.close.id))
    const [row] = await tx.insert(tariffRates).values({
      serviceId: insert.serviceId, scope: insert.scope, departmentId: insert.departmentId, payerId: insert.payerId,
      roomCategoryId: insert.roomCategoryId, ward: insert.ward, amountPaise: insert.amountPaise,
      validFrom: insert.validFrom, validTo: insert.validTo, createdByName: byName,
    }).returning({ id: tariffRates.id })
    return { closed: (await rateById(tx, current.id))!, created: (await rateById(tx, row.id))! }
  })
}

/**
 * Set (or move) a version's end date. The overlap check runs here, under the service lock, so a
 * concurrent create/revise cannot slip a version in between the check and the update.
 */
export async function endRate(id: number, validTo: string, audit?: TariffAudit): Promise<RateRow | null> {
  return inTx(audit, async (tx) => {
    const [peek] = await tx.select({ serviceId: tariffRates.serviceId }).from(tariffRates).where(eq(tariffRates.id, id))
    if (!peek) return null
    await lockService(tx, peek.serviceId)
    const [current] = await tx.select().from(tariffRates).where(eq(tariffRates.id, id)).for('update')
    const others = (await liveRates(tx, current.serviceId)).filter((r) => r.id !== id).map(toDatedRate)
    const conflict = findOverlap({ ...toDatedRate(current), validTo }, others)
    if (conflict) throw new TariffOverlapError(conflict.id ?? null)
    const [row] = await tx.update(tariffRates).set({ validTo }).where(eq(tariffRates.id, id)).returning({ id: tariffRates.id })
    return row ? rateById(tx, row.id) : null
  })
}

export async function deactivateRate(id: number, audit?: TariffAudit): Promise<RateRow | null> {
  return inTx(audit, async (tx) => {
    const [row] = await tx.update(tariffRates).set({ deactivatedAt: sql`coalesce(${tariffRates.deactivatedAt}, now())` })
      .where(eq(tariffRates.id, id)).returning({ id: tariffRates.id })
    return row ? rateById(tx, row.id) : null
  })
}

export async function loadPricingContext(serviceId: number): Promise<{ service: ServiceForPricing | null; rates: TariffRateCandidate[] }> {
  const db = getDb()
  const [service] = await db.select({
    id: serviceCatalog.id, code: serviceCatalog.code, name: serviceCatalog.name, departmentId: serviceCatalog.departmentId,
    isActive: serviceCatalog.isActive, hsnSac: serviceCatalog.hsnSac, gstRateBp: serviceCatalog.gstRateBp,
  }).from(serviceCatalog).where(eq(serviceCatalog.id, serviceId)).limit(1)
  if (!service) return { service: null, rates: [] }
  const rows = await rateSelect(db).where(and(eq(tariffRates.serviceId, serviceId), isNull(tariffRates.deactivatedAt)))
  return { service, rates: rows.map(toRateCandidate) }
}

// ---------- room categories ----------

export async function listRoomCategories(includeInactive = false): Promise<RoomCategory[]> {
  const q = getDb().select().from(roomCategories)
  return (includeInactive ? q : q.where(eq(roomCategories.isActive, true))).orderBy(asc(roomCategories.name))
}

export async function createRoomCategory(input: { code: string; name: string }, audit?: TariffAudit): Promise<RoomCategory> {
  return inTx(audit, async (tx) => {
    const [row] = await tx.insert(roomCategories).values({ code: input.code, name: input.name }).returning()
    return row
  })
}

export async function updateRoomCategory(id: number, patch: { name?: string; isActive?: boolean }, audit?: TariffAudit): Promise<RoomCategory | null> {
  if (Object.keys(patch).length === 0) {
    const [row] = await getDb().select().from(roomCategories).where(eq(roomCategories.id, id)).limit(1)
    return row ?? null
  }
  return inTx(audit, async (tx) => {
    const [row] = await tx.update(roomCategories).set(patch).where(eq(roomCategories.id, id)).returning()
    return row ?? null
  })
}

export async function listRoomsWithCategory(): Promise<{ id: number; ward: string; roomNumber: string; bedNumber: string; roomCategoryId: number | null }[]> {
  return getDb().select({
    id: rooms.id, ward: rooms.ward, roomNumber: rooms.roomNumber, bedNumber: rooms.bedNumber, roomCategoryId: rooms.roomCategoryId,
  }).from(rooms).orderBy(asc(rooms.ward), asc(rooms.roomNumber), asc(rooms.bedNumber))
}

export async function setRoomCategory(roomId: number, roomCategoryId: number | null, audit?: TariffAudit): Promise<boolean> {
  return inTx(audit, async (tx) => {
    const updated = await tx.update(rooms).set({ roomCategoryId }).where(eq(rooms.id, roomId)).returning({ id: rooms.id })
    return updated.length > 0
  })
}

// ---------- packages ----------

export async function listPackageItems(packageServiceId: number): Promise<{ itemServiceId: number; code: string; name: string; quantity: number }[]> {
  return getDb().select({
    itemServiceId: servicePackageItems.itemServiceId, code: serviceCatalog.code, name: serviceCatalog.name, quantity: servicePackageItems.quantity,
  }).from(servicePackageItems)
    .innerJoin(serviceCatalog, eq(servicePackageItems.itemServiceId, serviceCatalog.id))
    .where(eq(servicePackageItems.packageServiceId, packageServiceId))
    .orderBy(asc(serviceCatalog.code))
}

/** Replace a package's whole item list in one transaction (delete + insert). */
export async function replacePackageItems(packageServiceId: number, items: PackageItemsInput['items'], audit?: TariffAudit): Promise<void> {
  await inTx(audit, async (tx) => {
    // Lock the package and every item (ascending, like every multi-service write), then re-check
    // categories: a concurrent category change cannot nest packages after the route's check.
    const ids = [...new Set([packageServiceId, ...items.map((it) => it.serviceId)])]
    const locked = await tx.select({ id: serviceCatalog.id, category: serviceCatalog.category }).from(serviceCatalog)
      .where(inArray(serviceCatalog.id, ids)).orderBy(asc(serviceCatalog.id)).for('update')
    const category = new Map(locked.map((r) => [r.id, r.category]))
    if (!category.has(packageServiceId)) throw new Error('Service not found')
    if (category.get(packageServiceId) !== 'package' || items.some((it) => category.get(it.serviceId) === 'package')) {
      throw new TariffPackageIntegrityError(PACKAGE_CHANGED_MESSAGE)
    }
    await tx.delete(servicePackageItems).where(eq(servicePackageItems.packageServiceId, packageServiceId))
    if (items.length > 0) {
      await tx.insert(servicePackageItems).values(items.map((it) => ({ packageServiceId, itemServiceId: it.serviceId, quantity: it.quantity })))
    }
  })
}

// ---------- import ----------

export async function getImportLookups(): Promise<ImportLookups> {
  const db = getDb()
  const [depts, payerRows, cats, services, rates, packageItems] = await Promise.all([
    db.select({ id: departments.id, code: departments.code }).from(departments),
    db.select({ id: payers.id, code: payers.payerId }).from(payers),
    db.select({ id: roomCategories.id, code: roomCategories.code }).from(roomCategories),
    db.select({ id: serviceCatalog.id, code: serviceCatalog.code, category: serviceCatalog.category }).from(serviceCatalog),
    db.select().from(tariffRates).where(isNull(tariffRates.deactivatedAt)),
    db.select({ pkg: servicePackageItems.packageServiceId, item: servicePackageItems.itemServiceId }).from(servicePackageItems),
  ])
  return {
    departmentsByCode: new Map(depts.map((d) => [d.code.toUpperCase(), d.id])),
    payersByCode: new Map(payerRows.map((p) => [p.code.toUpperCase(), p.id])),
    roomCategoriesByCode: new Map(cats.map((c) => [c.code.toUpperCase(), c.id])),
    servicesByCode: new Map(services.map((s) => [s.code.toUpperCase(), { id: s.id, category: s.category }])),
    existingRates: rates.map(toDatedRate),
    packagesWithItems: new Set(packageItems.map((p) => p.pkg)),
    packageItemIds: new Set(packageItems.map((p) => p.item)),
  }
}

/** Insert new codes and update existing ones (by `existingId`), all-or-nothing. Returns the rows written. */
export async function commitServiceImport(rows: ServiceImportRow[], audit?: TariffAudit): Promise<number> {
  if (rows.length === 0) return 0
  return inTx(audit, async (tx) => {
    const existingIds = rows.flatMap((r) => (r.existingId === null ? [] : [r.existingId]))
    if (existingIds.length > 0) {
      const current = await tx.select({ id: serviceCatalog.id, category: serviceCatalog.category }).from(serviceCatalog)
        .where(inArray(serviceCatalog.id, [...new Set(existingIds)])).orderBy(asc(serviceCatalog.id)).for('update')
      const from = new Map(current.map((c) => [c.id, c.category]))
      await assertCategoryChangesAllowed(tx, rows.flatMap((r) =>
        r.existingId !== null && from.has(r.existingId) ? [{ id: r.existingId, from: from.get(r.existingId)!, to: r.category }] : []))
    }
    let applied = 0
    for (const r of rows) {
      const values = { name: r.name, departmentId: r.departmentId, category: r.category, hsnSac: r.hsnSac, gstRateBp: r.gstRateBp, isActive: r.isActive }
      if (r.existingId !== null) {
        const updated = await tx.update(serviceCatalog).set({ ...values, updatedAt: new Date() })
          .where(eq(serviceCatalog.id, r.existingId)).returning({ id: serviceCatalog.id })
        applied += updated.length
      } else {
        await tx.insert(serviceCatalog).values({ code: r.code, ...values })
        applied += 1
      }
    }
    return applied
  })
}

const RATE_INSERT_CHUNK = 1000

/** Insert validated rate rows (wards normalised), all-or-nothing; the DB exclusion is the overlap guard. */
export async function commitRateImport(rows: RateCreateInput[], byName: string, audit?: TariffAudit): Promise<number> {
  if (rows.length === 0) return 0
  return inTx(audit, async (tx) => {
    // Same lock as createRate/reviseRate, taken in ascending id order before any insert.
    await lockServices(tx, rows.map((r) => r.serviceId))
    const values = rows.map((r) => ({
      serviceId: r.serviceId, scope: r.scope, departmentId: r.departmentId ?? null, payerId: r.payerId ?? null,
      roomCategoryId: r.roomCategoryId ?? null, ward: wardOrNull(r.ward), amountPaise: r.amountPaise,
      validFrom: r.validFrom, validTo: r.validTo ?? null, createdByName: byName,
    }))
    for (let i = 0; i < values.length; i += RATE_INSERT_CHUNK) {
      await tx.insert(tariffRates).values(values.slice(i, i + RATE_INSERT_CHUNK))
    }
    return values.length
  })
}
