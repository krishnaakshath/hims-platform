import { getDb } from '@/db/client'
import { doctorAssignments } from '@/db/schema'
import { gte, sql } from 'drizzle-orm'

// Same day-boundary convention as listTodaysAssignments() in
// doctor-assignments.ts: server-local midnight, not UTC -- this pilot runs
// in one timezone, and matching the app's existing "today" boundary keeps
// the queue from resetting at a different moment than everything else.
function startOfToday(): Date {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return start
}

// Ticket numbers are (count of today's assignments) + 1, computed fresh at
// insert time rather than stored as a running sequence (spec §2): the daily
// reset is automatic (a new day has zero rows counted), with no unbounded
// counter and no cross-day collision risk, since the display (Task 3) only
// ever scopes to "today". Not guarded against two literally simultaneous
// check-ins racing the same count -- see this plan's header, "Scope
// decisions" #5, for why that's an intentional non-goal here.
export async function getNextQueueTicketNumberForToday(): Promise<number> {
  const [{ count }] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(doctorAssignments)
    .where(gte(doctorAssignments.createdAt, startOfToday()))
  return count + 1
}
