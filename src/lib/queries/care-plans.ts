import { getDb } from '@/db/client'
import { carePlans, carePlanGoals } from '@/db/schema'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'

export interface CarePlanGoal {
  id: number
  description: string
  targetDate: string | null
  status: 'active' | 'met' | 'not_met' | 'discontinued'
  statusUpdatedAt: string | null
  statusUpdatedByName: string | null
}

export interface CarePlanWithGoals {
  id: number
  title: string
  authorName: string
  status: 'active' | 'superseded'
  startedAt: string
  nextReviewDate: string | null
  supersededAt: string | null
  goals: CarePlanGoal[]
}

export interface CreateCarePlanInput {
  patientId: string
  title: string
  authorName: string
  nextReviewDate: string | null
  goals: { description: string; targetDate: string | null }[]
}

export interface CreateCarePlanResult {
  id: number
  supersededPlanId: number | null
}

// A new care plan supersedes (never deletes) the patient's prior active plan
// -- same append-only principle as encounter notes: the old plan's row and
// its goals stay in the table, just flipped to `status: 'superseded'` with a
// `supersededAt` timestamp, so the full care-plan history remains queryable.
//
// Final whole-branch review (Important): SELECT active plan -> UPDATE
// (supersede) -> INSERT with no row lock is racy under READ COMMITTED --
// two truly concurrent creates for the same patient (a double-submit) could
// both read "no active plan" and both insert one, leaving two active plans.
// A `SELECT ... FOR UPDATE` on the active-plan lookup does NOT fix this: it
// locks zero rows in exactly the case that needs protecting (no existing
// active plan to lock). The reviewer-ruled fix is a per-patient row lock --
// `SELECT ... FOR UPDATE` on the `patients` row itself, as the transaction's
// very first statement -- which serializes concurrent creates for the same
// patient without a new migration or partial unique index (this codebase
// has zero partial indexes). The supersede UPDATE is also made set-based
// (`WHERE patientId = ? AND status = 'active'`, not `WHERE id = <the one row
// read earlier>`) so that if two active rows ever do exist (a bug, or data
// predating this fix), the very next create self-corrects by superseding
// all of them rather than leaving one stuck active forever.
export async function createCarePlan(input: CreateCarePlanInput): Promise<CreateCarePlanResult> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM patients WHERE id = ${input.patientId} FOR UPDATE`)

    const [existingActive] = await tx
      .select()
      .from(carePlans)
      .where(and(eq(carePlans.patientId, input.patientId), eq(carePlans.status, 'active')))

    if (existingActive) {
      await tx
        .update(carePlans)
        .set({ status: 'superseded', supersededAt: new Date() })
        .where(and(eq(carePlans.patientId, input.patientId), eq(carePlans.status, 'active')))
    }

    const [created] = await tx
      .insert(carePlans)
      .values({
        patientId: input.patientId,
        title: input.title,
        authorName: input.authorName,
        nextReviewDate: input.nextReviewDate,
      })
      .returning()

    if (input.goals.length > 0) {
      await tx.insert(carePlanGoals).values(
        input.goals.map((goal) => ({
          carePlanId: created.id,
          description: goal.description,
          targetDate: goal.targetDate,
        })),
      )
    }

    return { id: created.id, supersededPlanId: existingActive?.id ?? null }
  })
}

function toDateString(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

// Two queries plus a Map keyed by carePlanId, not a join -- a join's result
// rows would need per-plan grouping logic in application code anyway (a
// join gives one row per plan/goal pair, not a plan with a nested goals
// array), so two simple queries is the simpler correct approach here.
export async function listCarePlansForPatient(patientId: string): Promise<CarePlanWithGoals[]> {
  const plans = await getDb()
    .select()
    .from(carePlans)
    .where(eq(carePlans.patientId, patientId))
    .orderBy(desc(carePlans.startedAt), desc(carePlans.id))

  if (plans.length === 0) return []

  const planIds = plans.map((p) => p.id)
  const goals = await getDb()
    .select()
    .from(carePlanGoals)
    .where(inArray(carePlanGoals.carePlanId, planIds))
    .orderBy(carePlanGoals.id)

  const goalsByPlanId = new Map<number, CarePlanGoal[]>()
  for (const goal of goals) {
    const list = goalsByPlanId.get(goal.carePlanId) ?? []
    list.push({
      id: goal.id,
      description: goal.description,
      targetDate: toDateString(goal.targetDate),
      status: goal.status,
      statusUpdatedAt: toDateString(goal.statusUpdatedAt),
      statusUpdatedByName: goal.statusUpdatedByName,
    })
    goalsByPlanId.set(goal.carePlanId, list)
  }

  return plans.map((plan) => ({
    id: plan.id,
    title: plan.title,
    authorName: plan.authorName,
    status: plan.status,
    startedAt: toDateString(plan.startedAt)!,
    nextReviewDate: toDateString(plan.nextReviewDate),
    supersededAt: toDateString(plan.supersededAt),
    goals: goalsByPlanId.get(plan.id) ?? [],
  }))
}

export interface UpdateGoalStatusResult {
  ok: boolean
  error?: string
  patientId?: string
}

// Follows signNote's shape (src/lib/queries/encounter-notes.ts): an
// existence/status pre-check for a clear error message, then the real
// safety guarantee is the conditional `UPDATE ... WHERE status = 'active'`,
// since two racing calls can both pass the pre-check before either writes.
export async function updateGoalStatus(
  goalId: number,
  status: 'met' | 'not_met' | 'discontinued',
  statusUpdatedByName: string,
): Promise<UpdateGoalStatusResult> {
  const [goal] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.id, goalId))
  if (!goal) return { ok: false, error: 'Goal not found' }
  if (goal.status !== 'active') return { ok: false, error: 'Goal is already in a terminal state' }

  const result = await getDb()
    .update(carePlanGoals)
    .set({ status, statusUpdatedAt: new Date(), statusUpdatedByName })
    .where(and(eq(carePlanGoals.id, goalId), eq(carePlanGoals.status, 'active')))
    .returning({ id: carePlanGoals.id, carePlanId: carePlanGoals.carePlanId })

  if (result.length === 0) return { ok: false, error: 'Goal is already in a terminal state' }

  const [carePlan] = await getDb().select().from(carePlans).where(eq(carePlans.id, result[0].carePlanId))
  return { ok: true, patientId: carePlan.patientId }
}
