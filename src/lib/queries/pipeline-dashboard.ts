import { getDb } from '@/db/client'
import { patients, patientTrialScreenings, formSubmissions } from '@/db/schema'
import { eq, and, gte, lte } from 'drizzle-orm'
import { getOrSetCache, pipelineDashboardCacheKey, pipelineDashboardTrendCacheKey } from '@/lib/cache'
import { publicPatientColumns } from '@/lib/queries/patient-columns'

export interface PipelineDateRange {
  from: Date
  to: Date
}

export interface PipelinePerformance {
  referralsReceived: number
  formsCompleted: number
  patientsClassified: number
  avgDaysToClassify: number | null
}

export interface PipelineTrendPoint {
  date: string
  referrals: number
  formsCompleted: number
  classified: number
}

export async function getPipelinePerformance(range: PipelineDateRange): Promise<PipelinePerformance> {
  return getOrSetCache(pipelineDashboardCacheKey(range.from.toISOString(), range.to.toISOString()), 30, async () => {
    const db = getDb()

    const referrals = await db
      .select(publicPatientColumns)
      .from(patients)
      .where(and(gte(patients.dateAdded, range.from), lte(patients.dateAdded, range.to)))

    const completedForms = await db
      .select()
      .from(formSubmissions)
      .where(and(eq(formSubmissions.status, 'completed'), gte(formSubmissions.completedDate, range.from), lte(formSubmissions.completedDate, range.to)))

    // A patient counts as "classified" once a screening row exists for them
    // (the rule engine has run at least once) and their chart's most recent
    // (re-)evaluation timestamp, `chartDataAsOf`, falls in the selected
    // window. `chartDataAsOf` is bumped by auto-classify-on-complete, so it
    // is the one real, already-existing signal for "classification activity".
    const screenedPatientIds = new Set((await db.select({ patientId: patientTrialScreenings.patientId }).from(patientTrialScreenings)).map((r) => r.patientId))
    const candidatesInWindow = await db
      .select(publicPatientColumns)
      .from(patients)
      .where(and(gte(patients.chartDataAsOf, range.from), lte(patients.chartDataAsOf, range.to)))
    const classifiedInWindow = candidatesInWindow.filter((p) => screenedPatientIds.has(p.id))

    const daysToClassify = classifiedInWindow
      .map((p) => (p.chartDataAsOf.getTime() - p.dateAdded.getTime()) / (1000 * 60 * 60 * 24))
      .filter((days) => days >= 0)

    return {
      referralsReceived: referrals.length,
      formsCompleted: completedForms.length,
      patientsClassified: classifiedInWindow.length,
      avgDaysToClassify: daysToClassify.length > 0 ? daysToClassify.reduce((a, b) => a + b, 0) / daysToClassify.length : null,
    }
  })
}

// Same three "pipeline activity" signals as getPipelinePerformance above
// (referral received / form completed / classification run), but bucketed by
// calendar day instead of summed into one KPI, so the dashboard can chart
// activity across the selected range rather than only showing a single
// aggregate number per KPI. Uses `.toISOString().slice(0, 10)` for the day
// key -- the same UTC-day convention this page's own date-range form already
// uses for its `defaultValue`s -- so a day bucket boundary here always lines
// up with what the date pickers above the chart show.
export async function getPipelineTrend(range: PipelineDateRange): Promise<PipelineTrendPoint[]> {
  return getOrSetCache(pipelineDashboardTrendCacheKey(range.from.toISOString(), range.to.toISOString()), 30, async () => {
    const db = getDb()

    const referrals = await db
      .select({ dateAdded: patients.dateAdded })
      .from(patients)
      .where(and(gte(patients.dateAdded, range.from), lte(patients.dateAdded, range.to)))

    const completedForms = await db
      .select({ completedDate: formSubmissions.completedDate })
      .from(formSubmissions)
      .where(and(eq(formSubmissions.status, 'completed'), gte(formSubmissions.completedDate, range.from), lte(formSubmissions.completedDate, range.to)))

    const screenedPatientIds = new Set((await db.select({ patientId: patientTrialScreenings.patientId }).from(patientTrialScreenings)).map((r) => r.patientId))
    const candidatesInWindow = await db
      .select({ id: patients.id, chartDataAsOf: patients.chartDataAsOf })
      .from(patients)
      .where(and(gte(patients.chartDataAsOf, range.from), lte(patients.chartDataAsOf, range.to)))
    const classifiedInWindow = candidatesInWindow.filter((p) => screenedPatientIds.has(p.id))

    const dayKey = (d: Date) => d.toISOString().slice(0, 10)
    const buckets = new Map<string, PipelineTrendPoint>()
    const bucketFor = (key: string) => {
      let entry = buckets.get(key)
      if (!entry) {
        entry = { date: key, referrals: 0, formsCompleted: 0, classified: 0 }
        buckets.set(key, entry)
      }
      return entry
    }

    for (const r of referrals) bucketFor(dayKey(r.dateAdded)).referrals += 1
    for (const f of completedForms) {
      // completedDate is nullable on the column even though this query
      // already filters to status === 'completed' -- guard rather than
      // assume the data is always internally consistent.
      if (f.completedDate) bucketFor(dayKey(f.completedDate)).formsCompleted += 1
    }
    for (const c of classifiedInWindow) bucketFor(dayKey(c.chartDataAsOf)).classified += 1

    return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date))
  })
}
