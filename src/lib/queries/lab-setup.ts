// SP5 lab setup (Settings → Lab setup, LAB_SETUP_ROLES): the service-area PIN list that
// decides who is a "local patient" (Ruling 3), the home-collection windows, and each lab
// test's sample type, tube and SP2 tariff service. Every write is one transaction with its
// audit row on the same `tx`. Audit details carry ids, counts and field names only.
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  homeCollectionWindows, labServiceAreaPins, labTests, serviceCatalog,
  type HomeCollectionWindowRow, type ServiceAreaPinRow,
} from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import type { WriteExecutor } from '@/lib/queries/executor'
import { windowsOverlap } from '@/lib/home-collection/rules'
import type { SampleContainer, SampleType } from '@/lib/labs/catalog'
import type { CollectionWindowInput, CollectionWindowPatch, LabTestSetupRequest } from '@/lib/labs/validation'

export type { ServiceAreaPinRow, HomeCollectionWindowRow }

// ── Service-area PINs ────────────────────────────────────────────────────────

export async function listServiceAreaPins(): Promise<ServiceAreaPinRow[]> {
  return getDb().select().from(labServiceAreaPins).orderBy(asc(labServiceAreaPins.pinCode))
}

export async function getActiveServicePins(ex: Pick<WriteExecutor, 'select'> = getDb()): Promise<Set<string>> {
  const rows = await ex.select({ pinCode: labServiceAreaPins.pinCode }).from(labServiceAreaPins).where(eq(labServiceAreaPins.isActive, true))
  return new Set(rows.map((r) => r.pinCode))
}

/** A patient (or address) PIN is local only when it is in the active service-area list. */
export async function isLocalPatientPin(pinCode: string | null, ex: Pick<WriteExecutor, 'select'> = getDb()): Promise<boolean> {
  const pin = pinCode?.trim()
  if (!pin) return false
  const [row] = await ex
    .select({ id: labServiceAreaPins.id })
    .from(labServiceAreaPins)
    .where(and(eq(labServiceAreaPins.pinCode, pin), eq(labServiceAreaPins.isActive, true)))
    .limit(1)
  return row !== undefined
}

/**
 * Adds already-validated PINs (see `parsePinList`). A PIN that exists but is inactive is
 * reactivated; a null label never wipes a stored one. One advisory lock serialises
 * concurrent adds so the counts are exact.
 */
export async function addServiceAreaPins(
  pins: string[],
  areaLabel: string | null,
  session: Session,
): Promise<{ added: number; reactivated: number; unchanged: number }> {
  const unique = [...new Set(pins)]
  if (unique.length === 0) return { added: 0, reactivated: 0, unchanged: 0 }
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('lab_service_area_pins'))`)
    const existing = await tx
      .select({ pinCode: labServiceAreaPins.pinCode, isActive: labServiceAreaPins.isActive })
      .from(labServiceAreaPins)
      .where(inArray(labServiceAreaPins.pinCode, unique))
    const reactivated = existing.filter((e) => !e.isActive).length
    const unchanged = existing.length - reactivated
    const added = unique.length - existing.length
    await tx
      .insert(labServiceAreaPins)
      .values(unique.map((pinCode) => ({ pinCode, areaLabel, createdByName: session.name })))
      .onConflictDoUpdate({
        target: labServiceAreaPins.pinCode,
        set: {
          isActive: true,
          areaLabel: sql`coalesce(excluded.area_label, ${labServiceAreaPins.areaLabel})`,
          updatedAt: sql`now()`,
        },
      })
    await logAudit(session, 'changed lab service area', null, `added=${added} reactivated=${reactivated}`, tx)
    return { added, reactivated, unchanged }
  })
}

export async function setServiceAreaPinActive(id: number, isActive: boolean, session: Session): Promise<ServiceAreaPinRow | null> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(labServiceAreaPins)
      .set({ isActive, updatedAt: sql`now()` })
      .where(eq(labServiceAreaPins.id, id))
      .returning()
    if (!row) return null
    await logAudit(session, 'changed lab service area', null, `pin=${id} active=${isActive}`, tx)
    return row
  })
}

// ── Collection windows ───────────────────────────────────────────────────────

export async function listCollectionWindows(includeInactive = true): Promise<HomeCollectionWindowRow[]> {
  return getDb()
    .select()
    .from(homeCollectionWindows)
    .where(includeInactive ? undefined : eq(homeCollectionWindows.isActive, true))
    .orderBy(asc(homeCollectionWindows.sortOrder), asc(homeCollectionWindows.startTime), asc(homeCollectionWindows.id))
}

type WindowTx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

async function lockWindows(tx: WindowTx) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('home_collection_windows'))`)
}

async function overlapsActive(tx: WindowTx, w: { startTime: string; endTime: string }, exceptId: number | null): Promise<boolean> {
  const others = await tx
    .select({ startTime: homeCollectionWindows.startTime, endTime: homeCollectionWindows.endTime })
    .from(homeCollectionWindows)
    .where(exceptId === null
      ? eq(homeCollectionWindows.isActive, true)
      : and(eq(homeCollectionWindows.isActive, true), ne(homeCollectionWindows.id, exceptId)))
  return others.some((o) => windowsOverlap(w, o))
}

export async function createCollectionWindow(
  input: CollectionWindowInput,
  session: Session,
): Promise<{ ok: true; window: HomeCollectionWindowRow } | { ok: false; error: 'overlap' }> {
  return getDb().transaction(async (tx) => {
    await lockWindows(tx)
    if (await overlapsActive(tx, input, null)) return { ok: false as const, error: 'overlap' as const }
    const [window] = await tx
      .insert(homeCollectionWindows)
      .values({ label: input.label, startTime: input.startTime, endTime: input.endTime, capacity: input.capacity, sortOrder: input.sortOrder ?? 0 })
      .returning()
    await logAudit(session, 'created home collection window', null, `window=${window.id}`, tx)
    return { ok: true as const, window }
  })
}

/**
 * Windows are never deleted, only deactivated; booked visits keep their own snapshot of the
 * label and times. A one-ended time change is merged with the stored window first, so an
 * inverted window is refused here (`invalid_times`) instead of failing the DB check.
 */
export async function updateCollectionWindow(
  id: number,
  patch: CollectionWindowPatch,
  session: Session,
): Promise<{ ok: true; window: HomeCollectionWindowRow } | { ok: false; error: 'not_found' | 'overlap' | 'invalid_times' }> {
  return getDb().transaction(async (tx) => {
    await lockWindows(tx)
    const [current] = await tx.select().from(homeCollectionWindows).where(eq(homeCollectionWindows.id, id)).for('update')
    if (!current) return { ok: false as const, error: 'not_found' as const }
    const merged = {
      startTime: patch.startTime ?? current.startTime,
      endTime: patch.endTime ?? current.endTime,
      isActive: patch.isActive ?? current.isActive,
    }
    if (merged.startTime >= merged.endTime) return { ok: false as const, error: 'invalid_times' as const }
    if (merged.isActive && (await overlapsActive(tx, merged, id))) return { ok: false as const, error: 'overlap' as const }
    const set: Partial<typeof homeCollectionWindows.$inferInsert> = {}
    if (patch.label !== undefined) set.label = patch.label
    if (patch.startTime !== undefined) set.startTime = patch.startTime
    if (patch.endTime !== undefined) set.endTime = patch.endTime
    if (patch.capacity !== undefined) set.capacity = patch.capacity
    if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder
    if (patch.isActive !== undefined) set.isActive = patch.isActive
    const [window] = await tx
      .update(homeCollectionWindows)
      .set({ ...set, updatedAt: sql`now()` })
      .where(eq(homeCollectionWindows.id, id))
      .returning()
    await logAudit(session, 'changed home collection window', null, `window=${id}`, tx)
    return { ok: true as const, window }
  })
}

// ── Lab tests: sample type, tube and tariff service ─────────────────────────

export interface LabTestSetupRow {
  id: number
  name: string
  code: string
  category: 'lab' | 'imaging'
  sampleType: SampleType | null
  container: SampleContainer | null
  serviceId: number | null
  serviceCode: string | null
  serviceName: string | null
}

const INVESTIGATION_CATEGORIES = ['investigation_lab', 'investigation_imaging'] as const

function labTestSetupSelect(ex: Pick<WriteExecutor, 'select'>) {
  return ex
    .select({
      id: labTests.id,
      name: labTests.name,
      code: labTests.code,
      category: labTests.category,
      sampleType: labTests.sampleType,
      container: labTests.container,
      serviceId: labTests.serviceId,
      serviceCode: serviceCatalog.code,
      serviceName: serviceCatalog.name,
    })
    .from(labTests)
    .leftJoin(serviceCatalog, eq(serviceCatalog.id, labTests.serviceId))
}

export async function listLabTestsWithSetup(): Promise<LabTestSetupRow[]> {
  return labTestSetupSelect(getDb()).orderBy(asc(labTests.name), asc(labTests.id))
}

export async function updateLabTestSetup(
  id: number,
  patch: LabTestSetupRequest,
  session: Session,
): Promise<{ ok: true; test: LabTestSetupRow } | { ok: false; error: 'not_found' | 'service_not_found' | 'service_not_investigation' }> {
  return getDb().transaction(async (tx) => {
    const [current] = await tx.select({ id: labTests.id }).from(labTests).where(eq(labTests.id, id)).for('update')
    if (!current) return { ok: false as const, error: 'not_found' as const }
    if (patch.serviceId !== undefined && patch.serviceId !== null) {
      const [service] = await tx.select({ category: serviceCatalog.category }).from(serviceCatalog).where(eq(serviceCatalog.id, patch.serviceId))
      if (!service) return { ok: false as const, error: 'service_not_found' as const }
      if (!(INVESTIGATION_CATEGORIES as readonly string[]).includes(service.category)) {
        return { ok: false as const, error: 'service_not_investigation' as const }
      }
    }
    const set: Partial<typeof labTests.$inferInsert> = {}
    if (patch.sampleType !== undefined) set.sampleType = patch.sampleType
    if (patch.container !== undefined) set.container = patch.container
    if (patch.serviceId !== undefined) set.serviceId = patch.serviceId
    const fields = Object.keys(set).sort()
    await tx.update(labTests).set(set).where(eq(labTests.id, id))
    const [test] = await labTestSetupSelect(tx).where(eq(labTests.id, id))
    await logAudit(session, 'changed lab test setup', null, `labTest=${id} fields=${fields.join(',')}`, tx)
    return { ok: true as const, test }
  })
}
