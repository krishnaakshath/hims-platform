import { getDb } from '@/db/client'
import { medications, medicationInventory, medicationEpisodes } from '@/db/schema'
import { asc, desc, eq, sql } from 'drizzle-orm'

export interface MedicationWithInventory {
  id: number
  name: string
  genericName: string | null
  medicationClass: string
  commonDose: string | null
  form: 'tablet' | 'capsule' | 'liquid' | 'injection' | 'other'
  quantityOnHand: number
  reorderThreshold: number
  unit: string
}

export async function listMedicationsWithInventory(): Promise<MedicationWithInventory[]> {
  const rows = await getDb()
    .select({
      id: medications.id, name: medications.name, genericName: medications.genericName,
      medicationClass: medications.medicationClass, commonDose: medications.commonDose, form: medications.form,
      quantityOnHand: medicationInventory.quantityOnHand, reorderThreshold: medicationInventory.reorderThreshold, unit: medicationInventory.unit,
    })
    .from(medications)
    .innerJoin(medicationInventory, eq(medicationInventory.medicationId, medications.id))
    .orderBy(asc(medications.name))
  return rows
}

export async function getMedicationById(id: number) {
  const [row] = await getDb().select().from(medications).where(eq(medications.id, id))
  return row ?? null
}

export interface CreateMedicationInput {
  name: string
  genericName: string | null
  medicationClass: string
  commonDose: string | null
  form: 'tablet' | 'capsule' | 'liquid' | 'injection' | 'other'
  quantityOnHand: number
  reorderThreshold: number
  unit: string
}

export interface CreateMedicationResult {
  ok: boolean
  error?: string
  medicationId?: number
}

const DUPLICATE_NAME_ERROR = 'A medication with that name is already in the catalog'
// Postgres SQLSTATE for unique_violation -- see telemedicine-sessions.ts for
// the same pattern/rationale: the `pg` driver throws plain Error-like
// objects carrying this on `.code` for any constraint violation.
const POSTGRES_UNIQUE_VIOLATION = '23505'

// The pre-check and the insert are both required: the pre-check gives a
// clean, friendly error for the common (non-racing) case, but two
// concurrent calls with the same name can both pass it before either
// INSERTs -- the loser then hits `medications_name_unique` inside the
// transaction below, which is caught and mapped to the same { ok: false }
// shape rather than escaping as an unhandled 500.
//
// The medications insert and the medicationInventory insert are wrapped in
// one `getDb().transaction(...)` (same shape as `dispenseMedication` in
// medication-dispenses.ts and `createCarePlan` in care-plans.ts) because the
// 1:1 relationship between them is load-bearing: `medicationInventory.
// medicationId` has a `.unique()` FK, and `listMedicationsWithInventory()`
// reads via an `innerJoin`, so a catalog row committed without its
// inventory row would be silently invisible on the very screen that
// created it. The transaction guarantees both rows land together or neither
// does.
export async function createMedicationWithInventory(input: CreateMedicationInput): Promise<CreateMedicationResult> {
  const db = getDb()

  const [existing] = await db.select({ id: medications.id }).from(medications)
    .where(sql`lower(${medications.name}) = lower(${input.name})`)
  if (existing) return { ok: false, error: DUPLICATE_NAME_ERROR }

  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx.insert(medications).values({
        name: input.name,
        genericName: input.genericName,
        medicationClass: input.medicationClass,
        commonDose: input.commonDose,
        form: input.form,
      }).returning()

      await tx.insert(medicationInventory).values({
        medicationId: created.id,
        quantityOnHand: input.quantityOnHand,
        reorderThreshold: input.reorderThreshold,
        unit: input.unit,
      })

      return { ok: true, medicationId: created.id }
    })
  } catch (error) {
    if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
      return { ok: false, error: DUPLICATE_NAME_ERROR }
    }
    throw error
  }
}

export interface ActiveMedicationSummaryRow {
  name: string
  medicationClass: string
  activeEpisodeCount: number
  inCatalog: boolean
}

// Practice-wide "currently prescribed" summary: counts active medication
// episodes grouped by drug name and class, across all patients. Returns
// only drug names and counts -- never a patient identity -- so unlike
// per-patient reads elsewhere in this codebase, this aggregate needs no
// audit-log entry.
//
// `inCatalog` is resolved by fetching every catalog name once and comparing
// case-insensitively in application code rather than a per-row correlated
// subquery: the catalog is ~15 rows, so a second full scan buys nothing a
// single extra query doesn't already give for free.
export async function listActiveMedicationEpisodeSummary(): Promise<ActiveMedicationSummaryRow[]> {
  const db = getDb()

  const rows = await db
    .select({
      name: medicationEpisodes.name,
      medicationClass: medicationEpisodes.medicationClass,
      activeEpisodeCount: sql<number>`count(*)`.mapWith(Number),
    })
    .from(medicationEpisodes)
    .where(eq(medicationEpisodes.status, 'active'))
    .groupBy(medicationEpisodes.name, medicationEpisodes.medicationClass)
    .orderBy(asc(medicationEpisodes.medicationClass), desc(sql`count(*)`))

  const catalogRows = await db.select({ name: medications.name }).from(medications)
  const catalogNames = new Set(catalogRows.map((m) => m.name.toLowerCase()))

  return rows.map((row) => ({
    ...row,
    inCatalog: catalogNames.has(row.name.toLowerCase()),
  }))
}
