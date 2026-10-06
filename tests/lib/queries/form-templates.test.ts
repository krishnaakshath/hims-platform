import { describe, it, expect } from 'vitest'
import { listFormTemplates } from '@/lib/queries/form-templates'

describe('listFormTemplates', () => {
  it('returns the seeded templates', async () => {
    const templates = await listFormTemplates()
    expect(templates.length).toBeGreaterThanOrEqual(2)
    expect(templates.some((t) => t.diagnosisTag === 'Major Depressive Disorder')).toBe(true)
  })
})
