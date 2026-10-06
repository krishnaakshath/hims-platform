import { describe, it, expect } from 'vitest'
import * as schema from '@/db/schema'

describe('schema', () => {
  it('exports all required tables', () => {
    expect(schema.trials).toBeDefined()
    expect(schema.patients).toBeDefined()
    expect(schema.diagnoses).toBeDefined()
    expect(schema.medicationEpisodes).toBeDefined()
    expect(schema.patientTrialScreenings).toBeDefined()
    expect(schema.screeningCriteriaResults).toBeDefined()
    expect(schema.auditLog).toBeDefined()
    expect(schema.users).toBeDefined()
    expect(schema.providers).toBeDefined()
    expect(schema.appointments).toBeDefined()
  })
})
