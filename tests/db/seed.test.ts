import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from '@/db/client'
import { trials, patients, charges, insuranceClaims, patientStatements, mockPayments, providers, appointments, rooms, documents, faxes, broadcasts, reviews } from '@/db/schema'
import { seed } from '@/db/seed'

describe('seed', () => {
  beforeAll(async () => {
    await seed()
  }, 60000)

  it('creates exactly 2 trials covering different conditions', async () => {
    const rows = await getDb().select().from(trials)
    expect(rows.length).toBe(2)
    const conditions = rows.map((r) => r.condition)
    expect(new Set(conditions).size).toBe(2)
  })

  it('creates at least 15 patients', async () => {
    const rows = await getDb().select().from(patients)
    expect(rows.length).toBeGreaterThanOrEqual(15)
  })

  it('creates charges covering every status in the workflow', async () => {
    const rows = await getDb().select().from(charges)
    expect(rows.length).toBeGreaterThanOrEqual(11)
    const statuses = new Set(rows.map((r) => r.status))
    expect(statuses).toEqual(new Set(['draft', 'pending_approval', 'approved', 'submitted']))
  })

  it('creates insurance claims covering rejected/denied/waiting/needs-investigation/paid', async () => {
    const rows = await getDb().select().from(insuranceClaims)
    const statuses = new Set(rows.map((r) => r.status))
    expect(statuses).toEqual(new Set(['rejected', 'denied', 'waiting_adjudication', 'needs_investigation', 'paid']))
  })

  it('creates patient statements and mock payments', async () => {
    const statements = await getDb().select().from(patientStatements)
    const payments = await getDb().select().from(mockPayments)
    expect(statements.length).toBeGreaterThanOrEqual(4)
    expect(payments.length).toBeGreaterThanOrEqual(2)
    expect(payments.some((p) => p.result === 'success')).toBe(true)
    expect(payments.some((p) => p.result === 'failed')).toBe(true)
  })

  it('creates the independent provider roster (not backfilled from currentProvider)', async () => {
    const rows = await getDb().select().from(providers)
    expect(rows.length).toBe(5)
    expect(new Set(rows.map((r) => r.colorTag)).size).toBe(5)
  })

  it('creates rooms across multiple wards, all available', async () => {
    const rows = await getDb().select().from(rooms)
    expect(rows.length).toBeGreaterThanOrEqual(6)
    expect(rows.every((r) => r.status === 'available')).toBe(true)
    expect(new Set(rows.map((r) => r.ward)).size).toBeGreaterThanOrEqual(2)
  })

  it('creates appointments spanning multiple statuses', async () => {
    const rows = await getDb().select().from(appointments)
    expect(rows.length).toBeGreaterThanOrEqual(10)
    const statuses = new Set(rows.map((r) => r.status))
    expect(statuses.has('scheduled')).toBe(true)
    expect(statuses.has('completed')).toBe(true)
    expect(statuses.has('cancelled')).toBe(true)
    expect(statuses.has('no_show')).toBe(true)
  })
})

describe('documents and faxes seed data', () => {
  it('seeds documents with a mix of New/Processed statuses', async () => {
    const rows = await getDb().select().from(documents)
    expect(rows.length).toBeGreaterThanOrEqual(10)
    expect(rows.some((d) => d.status === 'new')).toBe(true)
    expect(rows.some((d) => d.status === 'processed')).toBe(true)
  })

  it('seeds faxes with a mix of simulated delivered/failed statuses', async () => {
    const rows = await getDb().select().from(faxes)
    expect(rows.length).toBeGreaterThanOrEqual(8)
    expect(rows.some((f) => f.deliveryStatus === 'delivered')).toBe(true)
    expect(rows.some((f) => f.deliveryStatus === 'failed')).toBe(true)
  })
})

describe('broadcasts and reviews seed data', () => {
  it('creates the seeded broadcasts with recipient snapshots', async () => {
    const rows = await getDb().select().from(broadcasts)
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.every((r) => Array.isArray(r.recipients) && r.recipients.length === r.recipientCount)).toBe(true)
  })

  it('creates the seeded pre-screening experience surveys, including at least one still-sent response', async () => {
    const rows = await getDb().select().from(reviews)
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(rows.some((r) => r.status === 'sent')).toBe(true)
    expect(rows.some((r) => r.status === 'completed' && r.ratingOverall !== null)).toBe(true)
  })
})
