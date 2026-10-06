import { describe, it, expect } from 'vitest'
import { listReviews, getReview, listSurveyableSubmissions, getAverageExperienceRating } from '@/lib/queries/reviews'

describe('listReviews', () => {
  it('returns the seeded survey records', async () => {
    const rows = await listReviews({})
    expect(rows.length).toBeGreaterThanOrEqual(3)
  })

  it('filters by status', async () => {
    const sent = await listReviews({ status: 'sent' })
    expect(sent.every((r) => r.status === 'sent')).toBe(true)
  })
})

describe('getAverageExperienceRating', () => {
  it('averages only completed responses', async () => {
    const average = await getAverageExperienceRating()
    expect(average).not.toBeNull()
    expect(average!).toBeGreaterThan(0)
    expect(average!).toBeLessThanOrEqual(5)
  })
})

describe('listSurveyableSubmissions', () => {
  it('excludes submissions that already have a survey sent', async () => {
    const candidates = await listSurveyableSubmissions()
    const reviewed = await listReviews({})
    const reviewedSubmissionIds = new Set(reviewed.map((r) => r.formSubmissionId))
    expect(candidates.every((c) => !reviewedSubmissionIds.has(c.formSubmissionId))).toBe(true)
  })
})

describe('getReview', () => {
  it('returns null for a non-existent id', async () => {
    const review = await getReview(999999)
    expect(review).toBeNull()
  })
})
