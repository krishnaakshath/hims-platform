import { istHourOf, istYearMonthOf } from '@/lib/india-time'
import { getDb } from '@/db/client'
import { formSubmissions, formTemplates, patients, patientTrialScreenings, auditLog, appointments, reviews } from '@/db/schema'
import { eq, desc, or, inArray, sql } from 'drizzle-orm'
import { getOrSetCache, dashboardCacheKey } from '@/lib/cache'
import { getAverageExperienceRating } from '@/lib/queries/reviews'
import { publicPatientColumns } from '@/lib/queries/patient-columns'

const ACCOUNT_EVENT_ACTIONS = ['sent intake form', 'completed intake form', 'verified identity', 'ran classification']

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatHourRange(startHour: number, spanHours: number): string {
  const fmt = (h: number) => {
    const period = h < 12 || h === 24 ? 'AM' : 'PM'
    const display = h % 12 === 0 ? 12 : h % 12
    return `${display}:00 ${period}`
  }
  return `${fmt(startHour)} – ${fmt(startHour + spanHours)}`
}

/**
 * Buckets every appointment's start time into 2-hour windows and returns the
 * busiest one as a display label -- real data derived from the appointments
 * table (not invented), the equivalent of the reference dashboard's "Peak
 * activity hours" stat.
 */
export function computePeakHourRange(startTimes: Date[]): string | null {
  if (startTimes.length === 0) return null
  const buckets = new Array(12).fill(0) // 12 two-hour windows across a day
  for (const d of startTimes) buckets[Math.floor(istHourOf(d) / 2)] += 1
  let maxIdx = 0
  for (let i = 1; i < buckets.length; i++) if (buckets[i] > buckets[maxIdx]) maxIdx = i
  return formatHourRange(maxIdx * 2, 2)
}

export function computePatientsByMonth(dateAddedList: Date[]): { month: string; count: number }[] {
  // IST year/months, independent of the server's zone.
  const year = istYearMonthOf(new Date()).year
  const counts = new Array(12).fill(0)
  for (const d of dateAddedList) {
    const ym = istYearMonthOf(new Date(d))
    if (ym.year === year) counts[ym.month] += 1
  }
  return MONTH_LABELS.map((month, i) => ({ month, count: counts[i] }))
}

export async function getDashboardData() {
  return getOrSetCache(dashboardCacheKey(), 15, async () => {
    const db = getDb()

    // Every query below is independent of the others -- run them concurrently
    // rather than one-at-a-time. Sequential awaits here (each a network round
    // trip to Neon) previously added up to several seconds; Promise.all keeps
    // the total latency close to the single slowest query instead of the sum.
    const [
      latestForms,
      pendingForms,
      pendingFormsCountRows,
      patientRows,
      screeningRows,
      completedIntakeIdRows,
      recentEvents,
      appointmentStartRows,
      avgExperienceRating,
      completedReviewCountRows,
    ] = await Promise.all([
      db
        .select({ submission: formSubmissions, template: formTemplates, patient: publicPatientColumns })
        .from(formSubmissions)
        .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
        .innerJoin(patients, eq(formSubmissions.patientId, patients.id))
        .where(eq(formSubmissions.status, 'completed'))
        .orderBy(desc(formSubmissions.completedDate))
        .limit(5),
      db
        .select({ submission: formSubmissions, template: formTemplates, patient: publicPatientColumns })
        .from(formSubmissions)
        .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
        .innerJoin(patients, eq(formSubmissions.patientId, patients.id))
        .where(or(eq(formSubmissions.status, 'sent'), eq(formSubmissions.status, 'partial')))
        .orderBy(desc(formSubmissions.sentDate))
        .limit(5),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(formSubmissions)
        .where(or(eq(formSubmissions.status, 'sent'), eq(formSubmissions.status, 'partial'))),
      // Only id/name/dateAdded are ever rendered from this list, so select
      // only those -- no reason to cache clinician notes or the
      // encrypted-ID columns here. dateAdded also feeds the "patients added
      // by month" chart, so one select covers both needs.
      db.select({ id: patients.id, name: patients.name, dateAdded: patients.dateAdded }).from(patients),
      db.select({ patientId: patientTrialScreenings.patientId, overallStatus: patientTrialScreenings.overallStatus }).from(patientTrialScreenings),
      db.select({ id: formSubmissions.patientId }).from(formSubmissions).where(eq(formSubmissions.status, 'completed')),
      db
        .select()
        .from(auditLog)
        .where(inArray(auditLog.action, ACCOUNT_EVENT_ACTIONS))
        .orderBy(desc(auditLog.timestamp))
        .limit(10),
      db.select({ startsAt: appointments.startsAt }).from(appointments),
      getAverageExperienceRating(),
      db.select({ count: sql<number>`count(*)::int` }).from(reviews).where(eq(reviews.status, 'completed')),
    ])

    const pendingFormsTotal = pendingFormsCountRows[0].count
    const completedReviewCount = completedReviewCountRows[0].count

    // Patients with completed intake + at least one recorded diagnosis/medication,
    // but no screening row yet — the "ready but not yet classified" queue.
    const screenedIds = new Set(screeningRows.map((r) => r.patientId))
    const completedIntakeIds = new Set(completedIntakeIdRows.map((r) => r.id))
    const pendingClassification = patientRows
      .filter((p) => completedIntakeIds.has(p.id) && !screenedIds.has(p.id))
      .map((p) => ({ id: p.id, name: p.name }))

    // Real aggregates for the home dashboard's stat/chart row.
    const patientsByMonth = computePatientsByMonth(patientRows.map((p) => p.dateAdded))
    const screeningBreakdown = {
      green: screeningRows.filter((r) => r.overallStatus === 'green').length,
      yellow: screeningRows.filter((r) => r.overallStatus === 'yellow').length,
      red: screeningRows.filter((r) => r.overallStatus === 'red').length,
    }
    const peakHourRange = computePeakHourRange(appointmentStartRows.map((r) => r.startsAt))

    // Project the submission down explicitly rather than spreading the full
    // row -- `accessToken` is a 30-day unauthenticated bearer credential for
    // the intake portal, and this dashboard summary never needs it (it also
    // sits in the plaintext Upstash cache, so less PHI/credentials in here
    // is a real reduction in blast radius, not just an unused field).
    const projectForm = (r: { submission: typeof formSubmissions.$inferSelect; template: { name: string }; patient: { name: string } }) => ({
      id: r.submission.id,
      status: r.submission.status,
      sentDate: r.submission.sentDate,
      completedDate: r.submission.completedDate,
      templateName: r.template.name,
      patientName: r.patient.name,
    })

    return {
      latestForms: latestForms.map(projectForm),
      pendingForms: pendingForms.map(projectForm),
      pendingFormsTotal,
      pendingClassification,
      recentEvents,
      patientsByMonth,
      screeningBreakdown,
      peakHourRange,
      avgExperienceRating,
      completedReviewCount,
      // The ONE definition of "Total Patients" for every dashboard (Task 17):
      // distinct rows of the patients table. Not listPatientsWithStatus(null)
      // .length -- that list is a patient x screening join, so a patient
      // screened for two trials would be counted twice.
      totalPatients: patientRows.length,
    }
  })
}
