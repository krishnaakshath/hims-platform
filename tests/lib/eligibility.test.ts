import { describe, it, expect } from 'vitest'
import { evaluateEligibility, type TrialEligibilityConfig, type PatientChartSnapshot } from '@/lib/eligibility'

const MDD_TRIAL: TrialEligibilityConfig = {
  ageMin: 18,
  ageMax: 65,
  diagnosisCodes: [{ code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' }],
  ratingScales: [{ name: 'PHQ-9', description: 'Patient Health Questionnaire-9' }],
  medicationClasses: [{ className: 'SSRI/SNRI antidepressant', washoutDays: 56, rule: 'On current antidepressant dose for at least 8 weeks', ruleType: 'required_stable' }],
  exclusionDiagnoses: [{ code: 'F20.9', description: 'Schizophrenia, unspecified' }],
  minRatingScaleScore: 10,
}

const ADHD_TRIAL: TrialEligibilityConfig = {
  ageMin: 18,
  ageMax: 55,
  diagnosisCodes: [{ code: 'F90.2', description: 'ADHD, combined type' }],
  ratingScales: [{ name: 'ASRS-v1.1', description: 'Adult ADHD Self-Report Scale' }],
  medicationClasses: [{ className: 'Stimulant', washoutDays: 14, rule: 'No stimulant medication within the last 14 days', ruleType: 'washout_exclusion' }],
  exclusionDiagnoses: [],
  minRatingScaleScore: null,
}

function chart(overrides: Partial<PatientChartSnapshot> = {}): PatientChartSnapshot {
  return { dob: '1990-01-01', diagnoses: [], medications: [], ratingScales: [], ...overrides }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

describe('evaluateEligibility', () => {
  it('marks age in range green and out of range red', () => {
    const inRange = evaluateEligibility(MDD_TRIAL, chart({ dob: '1990-01-01' }))
    expect(inRange.find((r) => r.criterionKey === 'age-range')!.verdict).toBe('green')

    const tooYoung = evaluateEligibility(MDD_TRIAL, chart({ dob: new Date().toISOString().slice(0, 10) }))
    expect(tooYoung.find((r) => r.criterionKey === 'age-range')!.verdict).toBe('red')
  })

  it('tags age and diagnosis as inclusion criteria', () => {
    const results = evaluateEligibility(MDD_TRIAL, chart({ diagnoses: [{ code: 'F33.1', description: 'MDD' }] }))
    expect(results.find((r) => r.criterionKey === 'age-range')!.criterionType).toBe('inclusion')
    expect(results.find((r) => r.criterionKey === 'diagnosis')!.criterionType).toBe('inclusion')
  })

  it('matches a confirmed diagnosis green, an unmatched one red, and no diagnoses at all yellow', () => {
    const matched = evaluateEligibility(MDD_TRIAL, chart({ diagnoses: [{ code: 'F33.1', description: 'MDD' }] }))
    expect(matched.find((r) => r.criterionKey === 'diagnosis')!.verdict).toBe('green')

    const unmatched = evaluateEligibility(MDD_TRIAL, chart({ diagnoses: [{ code: 'F41.1', description: 'GAD' }] }))
    expect(unmatched.find((r) => r.criterionKey === 'diagnosis')!.verdict).toBe('red')

    const none = evaluateEligibility(MDD_TRIAL, chart({ diagnoses: [] }))
    expect(none.find((r) => r.criterionKey === 'diagnosis')!.verdict).toBe('yellow')
  })

  it('evaluates the minimum rating scale score threshold', () => {
    const above = evaluateEligibility(MDD_TRIAL, chart({ ratingScales: [{ name: 'PHQ-9', score: 18, date: '2026-09-01' }] }))
    expect(above.find((r) => r.criterionKey === 'rating-scale-threshold')!.verdict).toBe('green')

    const below = evaluateEligibility(MDD_TRIAL, chart({ ratingScales: [{ name: 'PHQ-9', score: 5, date: '2026-09-01' }] }))
    expect(below.find((r) => r.criterionKey === 'rating-scale-threshold')!.verdict).toBe('red')

    const missing = evaluateEligibility(MDD_TRIAL, chart({ ratingScales: [] }))
    expect(missing.find((r) => r.criterionKey === 'rating-scale-threshold')!.verdict).toBe('yellow')
  })

  it('skips the rating-scale criterion entirely when the trial has no minimum configured', () => {
    const results = evaluateEligibility(ADHD_TRIAL, chart())
    expect(results.some((r) => r.criterionKey === 'rating-scale-threshold')).toBe(false)
  })

  describe('required_stable medication rule (inclusion) -- e.g. MDD antidepressant stability', () => {
    it('is red when the patient is not on the required medication at all', () => {
      const results = evaluateEligibility(MDD_TRIAL, chart({ medications: [] }))
      const c = results.find((r) => r.criterionKey.startsWith('required-medication'))!
      expect(c.criterionType).toBe('inclusion')
      expect(c.verdict).toBe('red')
    })

    it('is yellow when on the medication but not yet past the required stability duration', () => {
      const results = evaluateEligibility(MDD_TRIAL, chart({
        medications: [{ name: 'Sertraline', medicationClass: 'SSRI/SNRI antidepressant', startDate: daysAgo(10), status: 'active' }],
      }))
      expect(results.find((r) => r.criterionKey.startsWith('required-medication'))!.verdict).toBe('yellow')
    })

    it('is green once stable on the medication past the required duration', () => {
      const results = evaluateEligibility(MDD_TRIAL, chart({
        medications: [{ name: 'Sertraline', medicationClass: 'SSRI/SNRI antidepressant', startDate: daysAgo(90), status: 'active' }],
      }))
      expect(results.find((r) => r.criterionKey.startsWith('required-medication'))!.verdict).toBe('green')
    })

    it('does not count an inactive (discontinued) episode as satisfying the requirement', () => {
      const results = evaluateEligibility(MDD_TRIAL, chart({
        medications: [{ name: 'Sertraline', medicationClass: 'SSRI/SNRI antidepressant', startDate: daysAgo(200), status: 'inactive' }],
      }))
      expect(results.find((r) => r.criterionKey.startsWith('required-medication'))!.verdict).toBe('red')
    })
  })

  describe('washout_exclusion medication rule (exclusion) -- e.g. ADHD stimulant washout', () => {
    it('is green when the patient is on no such medication', () => {
      const results = evaluateEligibility(ADHD_TRIAL, chart({ medications: [] }))
      const c = results.find((r) => r.criterionKey.startsWith('excluded-medication'))!
      expect(c.criterionType).toBe('exclusion')
      expect(c.verdict).toBe('green')
    })

    it('is red when actively on the excluded class within the washout window', () => {
      const results = evaluateEligibility(ADHD_TRIAL, chart({
        medications: [{ name: 'Vyvanse', medicationClass: 'Stimulant', startDate: daysAgo(3), status: 'active' }],
      }))
      expect(results.find((r) => r.criterionKey.startsWith('excluded-medication'))!.verdict).toBe('red')
    })

    it('is yellow (needs manual confirmation) when active but past the washout window', () => {
      const results = evaluateEligibility(ADHD_TRIAL, chart({
        medications: [{ name: 'Vyvanse', medicationClass: 'Stimulant', startDate: daysAgo(30), status: 'active' }],
      }))
      expect(results.find((r) => r.criterionKey.startsWith('excluded-medication'))!.verdict).toBe('yellow')
    })

    it('is red with no washout grace period at all for a zero-tolerance (washoutDays: 0) exclusion, no matter how long ago it started', () => {
      const zeroTolerance: TrialEligibilityConfig = {
        ...ADHD_TRIAL,
        medicationClasses: [{ className: 'NDRI (excluded class)', washoutDays: 0, rule: 'Not currently on an excluded medication class', ruleType: 'washout_exclusion' }],
      }
      const results = evaluateEligibility(zeroTolerance, chart({
        medications: [{ name: 'Bupropion', medicationClass: 'NDRI (excluded class)', startDate: daysAgo(500), status: 'active' }],
      }))
      expect(results.find((r) => r.criterionKey.startsWith('excluded-medication'))!.verdict).toBe('red')
    })
  })

  describe('exclusion diagnoses', () => {
    it('is red when a disqualifying diagnosis is present', () => {
      const results = evaluateEligibility(MDD_TRIAL, chart({ diagnoses: [{ code: 'F20.9', description: 'Schizophrenia' }] }))
      const c = results.find((r) => r.criterionKey.startsWith('exclusion-diagnosis'))!
      expect(c.criterionType).toBe('exclusion')
      expect(c.verdict).toBe('red')
    })

    it('is green when no disqualifying diagnosis is present', () => {
      const results = evaluateEligibility(MDD_TRIAL, chart({ diagnoses: [{ code: 'F33.1', description: 'MDD' }] }))
      expect(results.find((r) => r.criterionKey.startsWith('exclusion-diagnosis'))!.verdict).toBe('green')
    })

    it('produces no exclusion-diagnosis criteria when the trial configures none', () => {
      const results = evaluateEligibility(ADHD_TRIAL, chart())
      expect(results.some((r) => r.criterionKey.startsWith('exclusion-diagnosis'))).toBe(false)
    })
  })
})
