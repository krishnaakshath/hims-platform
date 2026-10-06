import { describe, it, expect } from 'vitest'
import { listScreeningsForTrial } from '@/lib/queries/trial-screenings'

describe('listScreeningsForTrial', () => {
  it('returns every patient screened against the seeded MDD trial, with evidence attached', async () => {
    const screenings = await listScreeningsForTrial('nct06911112')
    expect(screenings.length).toBeGreaterThan(0)

    const ids = screenings.map((p) => p.id)
    expect(ids).toContain('RD-0001')
    expect(ids).toContain('RD-0002')
    expect(ids).toContain('RD-0003')

    // Trial membership (which trial a patient's screening row belongs to)
    // is fixed at seed time. Unlike `overallStatus` and `criteria`, it's
    // never mutated by a "Refresh from Source Systems" eligibility re-run,
    // so it's safe to assert on directly against the shared dev DB.
    expect(ids).not.toContain('RD-0004') // seeded against the ADHD trial instead
    expect(ids).not.toContain('RD-0005')

    for (const p of screenings) {
      expect(['green', 'yellow', 'red']).toContain(p.overallStatus)
      for (const c of p.criteria) {
        expect(['green', 'yellow', 'red']).toContain(c.verdict)
      }
    }

    // A patient whose overall status is "red" must have at least one
    // criterion result that's also "red" to point to -- that criterion
    // (its text + evidence quote/source) is the "why they got rejected"
    // this query exists to surface.
    const rejectedWithCriteria = screenings.filter((p) => p.overallStatus === 'red' && p.criteria.length > 0)
    expect(rejectedWithCriteria.every((p) => p.criteria.some((c) => c.verdict === 'red'))).toBe(true)
  })

  it('only returns patients screened against the requested trial', async () => {
    const mdd = await listScreeningsForTrial('nct06911112')
    expect(mdd.some((p) => p.id === 'RD-0004')).toBe(false) // seeded against the ADHD trial instead

    const adhd = await listScreeningsForTrial('nct-adhd-demo-01')
    expect(adhd.some((p) => p.id === 'RD-0004')).toBe(true)
    expect(adhd.some((p) => p.id === 'RD-0001')).toBe(false) // seeded against the MDD trial instead
  })
})
