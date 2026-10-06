import type { Verdict } from '@/lib/rule-engine'

export interface EligibilityCriterionResult {
  criterionKey: string
  criterionText: string
  criterionType: 'inclusion' | 'exclusion'
  verdict: Verdict
  evidenceQuote: string
  evidenceSourceDoc: string
  evidenceSourceDate: string
}

export interface TrialEligibilityConfig {
  ageMin: number
  ageMax: number
  diagnosisCodes: { code: string; description: string }[]
  ratingScales: { name: string; description: string }[]
  medicationClasses: { className: string; washoutDays: number; rule: string; ruleType: 'washout_exclusion' | 'required_stable' }[]
  exclusionDiagnoses: { code: string; description: string }[]
  minRatingScaleScore: number | null
}

export interface PatientChartSnapshot {
  dob: string
  diagnoses: { code: string; description: string }[]
  medications: { name: string; medicationClass: string; startDate: string; status: 'active' | 'inactive' }[]
  ratingScales: { name: string; score: number; date: string }[]
}

function calculateAge(dob: string, asOf: Date): number {
  const birth = new Date(dob)
  let age = asOf.getFullYear() - birth.getFullYear()
  const hadBirthdayThisYear = asOf.getMonth() > birth.getMonth() || (asOf.getMonth() === birth.getMonth() && asOf.getDate() >= birth.getDate())
  if (!hadBirthdayThisYear) age--
  return age
}

const today = () => new Date()
const isoDate = (d: Date) => d.toISOString().slice(0, 10)

/**
 * The actual inclusion/exclusion rule engine: given a trial's configured
 * criteria and a patient's real chart data, computes a fresh verdict per
 * criterion with cited evidence. This is what "Run Classification" and
 * auto-classify-on-complete actually call now -- previously neither path
 * computed anything from real data, they only re-aggregated whatever
 * screeningCriteriaResults rows already existed (hand-authored demo rows
 * for the seeded hero patients, nothing for anyone else).
 */
export function evaluateEligibility(trial: TrialEligibilityConfig, chart: PatientChartSnapshot): EligibilityCriterionResult[] {
  const now = today()
  const results: EligibilityCriterionResult[] = []

  const age = calculateAge(chart.dob, now)
  results.push({
    criterionKey: 'age-range',
    criterionText: `Age ${trial.ageMin}-${trial.ageMax}`,
    criterionType: 'inclusion',
    verdict: age >= trial.ageMin && age <= trial.ageMax ? 'green' : 'red',
    evidenceQuote: `DOB ${chart.dob} (age ${age})`,
    evidenceSourceDoc: 'Patient record',
    evidenceSourceDate: isoDate(now),
  })

  const matchedDx = chart.diagnoses.find((d) => trial.diagnosisCodes.some((tc) => tc.code === d.code))
  results.push({
    criterionKey: 'diagnosis',
    criterionText: `Confirmed diagnosis (${trial.diagnosisCodes.map((c) => c.code).join('/')})`,
    criterionType: 'inclusion',
    verdict: matchedDx ? 'green' : chart.diagnoses.length === 0 ? 'yellow' : 'red',
    evidenceQuote: matchedDx ? `Dx: ${matchedDx.code} ${matchedDx.description}` : chart.diagnoses.length === 0 ? 'No diagnoses on file' : 'No matching diagnosis on file',
    evidenceSourceDoc: 'Condition list',
    evidenceSourceDate: isoDate(now),
  })

  if (trial.minRatingScaleScore != null && trial.ratingScales.length > 0) {
    const scaleName = trial.ratingScales[0].name
    const latest = chart.ratingScales.filter((r) => r.name === scaleName).sort((a, b) => b.date.localeCompare(a.date))[0]
    results.push({
      criterionKey: 'rating-scale-threshold',
      criterionText: `${scaleName} score >= ${trial.minRatingScaleScore}`,
      criterionType: 'inclusion',
      verdict: !latest ? 'yellow' : latest.score >= trial.minRatingScaleScore ? 'green' : 'red',
      evidenceQuote: latest ? `${scaleName} = ${latest.score} on ${latest.date}` : `No ${scaleName} score on file`,
      evidenceSourceDoc: 'Rating scale',
      evidenceSourceDate: latest?.date ?? isoDate(now),
    })
  }

  for (const mc of trial.medicationClasses) {
    const active = chart.medications.find((m) => m.medicationClass === mc.className && m.status === 'active')
    const daysSinceStart = active ? Math.floor((now.getTime() - new Date(active.startDate).getTime()) / 86400000) : null

    if (mc.ruleType === 'washout_exclusion') {
      let verdict: Verdict = 'green'
      let quote = `No active ${mc.className} medication on file`
      if (active && daysSinceStart !== null) {
        if (mc.washoutDays <= 0) {
          // Zero-tolerance exclusion (no washout grace period at all, e.g.
          // an entirely disallowed drug class) -- active at all is
          // disqualifying, full stop, never "needs manual confirmation".
          verdict = 'red'
          quote = `${active.name} (${mc.className}) active since ${active.startDate} -- protocol excludes this class entirely`
        } else if (daysSinceStart < mc.washoutDays) {
          verdict = 'red'
          quote = `${active.name} (${mc.className}) active, started ${active.startDate} -- within the ${mc.washoutDays}-day washout window`
        } else {
          verdict = 'yellow'
          quote = `${active.name} (${mc.className}) active since ${active.startDate}, past the ${mc.washoutDays}-day washout window -- confirm manually`
        }
      }
      results.push({
        criterionKey: `excluded-medication-${mc.className.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        criterionText: mc.rule,
        criterionType: 'exclusion',
        verdict,
        evidenceQuote: quote,
        evidenceSourceDoc: 'Medication list',
        evidenceSourceDate: isoDate(now),
      })
    } else {
      // required_stable: an inclusion criterion -- must BE on this class
      // for at least `washoutDays` (here used as a minimum-stability
      // duration, not a washout window).
      let verdict: Verdict = 'red'
      let quote = `No active ${mc.className} medication on file`
      if (active && daysSinceStart !== null) {
        if (daysSinceStart >= mc.washoutDays) {
          verdict = 'green'
          quote = `${active.name} (${mc.className}) active since ${active.startDate} -- stable for ${daysSinceStart} days`
        } else {
          verdict = 'yellow'
          quote = `${active.name} (${mc.className}) active since ${active.startDate} -- only ${daysSinceStart} of ${mc.washoutDays} required days`
        }
      }
      results.push({
        criterionKey: `required-medication-${mc.className.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        criterionText: mc.rule,
        criterionType: 'inclusion',
        verdict,
        evidenceQuote: quote,
        evidenceSourceDoc: 'Medication list',
        evidenceSourceDate: isoDate(now),
      })
    }
  }

  for (const ed of trial.exclusionDiagnoses) {
    const found = chart.diagnoses.find((d) => d.code === ed.code)
    results.push({
      criterionKey: `exclusion-diagnosis-${ed.code.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      criterionText: `No current ${ed.description} (${ed.code})`,
      criterionType: 'exclusion',
      verdict: found ? 'red' : 'green',
      evidenceQuote: found ? `Dx on file: ${found.code} ${found.description}` : `No ${ed.code} diagnosis on file`,
      evidenceSourceDoc: 'Condition list',
      evidenceSourceDate: isoDate(now),
    })
  }

  return results
}
