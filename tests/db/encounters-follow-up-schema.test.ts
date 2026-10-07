import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'
import {
  encounters, followUpOrders, followUpContactAttempts,
  encounterTypeEnum, encounterVisitTypeEnum, encounterStatusEnum,
  followUpStatusEnum, followUpSourceEnum, followUpIntervalUnitEnum,
  followUpContactChannelEnum, followUpContactOutcomeEnum,
} from '@/db/schema'
import { ENCOUNTER_STATUSES, ENCOUNTER_TYPES, ENCOUNTER_VISIT_TYPES } from '@/lib/encounters/status'
import { FOLLOW_UP_STATUSES, INTERVAL_UNITS } from '@/lib/follow-ups/rules'
import { CONTACT_CHANNELS, CONTACT_OUTCOMES } from '@/lib/follow-ups/validation'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

const MIGRATION = '2026-10-07-sp3-encounters-follow-up.sql'

describe('SP3 encounters & follow-up schema', () => {
  it('migration is idempotent and non-destructive', () => {
    expect(idempotencyProblems(readMigration(MIGRATION))).toEqual([])
  })

  it.each([['encounters', encounters], ['follow_up_orders', followUpOrders], ['follow_up_contact_attempts', followUpContactAttempts]] as const)(
    'migration declares every %s column', (_n, t) => {
      expect(missingColumns(t, readMigration(MIGRATION))).toEqual([])
    })

  it('every FK, unique and check constraint name is in the SQL and fits 63 chars', () => {
    const sqlText = readMigration(MIGRATION)
    for (const t of [encounters, followUpOrders, followUpContactAttempts]) {
      const c = getTableConfig(t)
      const names = [
        ...c.foreignKeys.map((f) => f.getName()), ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!),
        ...c.columns.filter((col) => col.isUnique).map((col) => col.uniqueName!),
      ]
      expect(names.length).toBeGreaterThan(0)
      for (const n of names) {
        expect(n.length, n).toBeLessThanOrEqual(63)
        expect(sqlText, n).toContain(n)
      }
    }
  })

  it('declares the ON DELETE behaviour of each FK in the migration', () => {
    const sqlText = readMigration(MIGRATION)
    for (const t of [encounters, followUpOrders, followUpContactAttempts]) {
      for (const fk of getTableConfig(t).foreignKeys) {
        const name = fk.getName()
        const block = sqlText.slice(sqlText.indexOf(`ADD CONSTRAINT ${name}`))
        const stmt = block.slice(0, block.indexOf(';'))
        const expected = fk.onDelete === 'set null' ? /ON DELETE SET NULL/ : fk.onDelete === 'cascade' ? /ON DELETE CASCADE/ : /^(?![\s\S]*ON DELETE)/
        expect(stmt, name).toMatch(expected)
      }
    }
  })

  it('names the contact-attempt FK explicitly (drizzle default exceeds 63 chars)', () => {
    const fk = getTableConfig(followUpContactAttempts).foreignKeys.find((f) => f.reference().columns[0].name === 'follow_up_order_id')!
    expect(fk.getName()).toBe('follow_up_contact_attempts_order_id_fk')
    expect(fk.onDelete).toBe('cascade')
  })

  it('enum values match the pure constants', () => {
    expect(encounterStatusEnum.enumValues).toEqual([...ENCOUNTER_STATUSES])
    expect(encounterTypeEnum.enumValues).toEqual([...ENCOUNTER_TYPES])
    expect(encounterVisitTypeEnum.enumValues).toEqual([...ENCOUNTER_VISIT_TYPES])
    expect(followUpStatusEnum.enumValues).toEqual([...FOLLOW_UP_STATUSES])
    expect(followUpIntervalUnitEnum.enumValues).toEqual([...INTERVAL_UNITS])
    expect(followUpContactChannelEnum.enumValues).toEqual([...CONTACT_CHANNELS])
    expect(followUpContactOutcomeEnum.enumValues).toEqual([...CONTACT_OUTCOMES])
    expect(followUpSourceEnum.enumValues).toEqual(['encounter', 'discharge', 'lab_report', 'manual'])
  })

  it('migration creates each enum type with every value', () => {
    const sqlText = readMigration(MIGRATION)
    for (const e of [encounterTypeEnum, encounterVisitTypeEnum, encounterStatusEnum, followUpStatusEnum, followUpSourceEnum,
      followUpIntervalUnitEnum, followUpContactChannelEnum, followUpContactOutcomeEnum]) {
      const values = e.enumValues.map((v) => `'${v}'`).join(', ')
      expect(sqlText, e.enumName).toContain(`CREATE TYPE ${e.enumName} AS ENUM (${values});`)
    }
  })
})

describe.skipIf(!process.env.DATABASE_URL)('SP3 schema (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const PID = `TEST-SP3-${RUN}`
  let providerId = 0
  const ids = { attempts: [] as number[], orders: [] as number[], encounters: [] as number[], appointments: [] as number[] }

  async function errorOf(p: Promise<unknown>): Promise<unknown> {
    try { await p } catch (e) { return e }
    return undefined
  }

  beforeEach(async () => {
    const { getDb } = await import('@/db/client')
    const { patients, providers } = await import('@/db/schema')
    const { eq } = await import('drizzle-orm')
    const db = getDb()
    const [p] = await db.select({ id: providers.id }).from(providers).where(eq(providers.isActive, true)).orderBy(providers.id).limit(1)
    providerId = p.id
    await db.insert(patients).values({ id: PID, name: 'Test SP3 Schema', dob: '1990-01-01' })
  })

  afterEach(async () => {
    const { getDb } = await import('@/db/client')
    const { patients, appointments } = await import('@/db/schema')
    const { eq, inArray } = await import('drizzle-orm')
    const db = getDb()
    // Children first.
    if (ids.attempts.length) await db.delete(followUpContactAttempts).where(inArray(followUpContactAttempts.id, ids.attempts.splice(0)))
    if (ids.orders.length) await db.delete(followUpOrders).where(inArray(followUpOrders.id, ids.orders.splice(0)))
    if (ids.encounters.length) await db.delete(encounters).where(inArray(encounters.id, ids.encounters.splice(0)))
    if (ids.appointments.length) await db.delete(appointments).where(inArray(appointments.id, ids.appointments.splice(0)))
    await db.delete(patients).where(eq(patients.id, PID))
  })

  async function insertEncounter(v: Partial<typeof encounters.$inferInsert>) {
    const { getDb } = await import('@/db/client')
    const [r] = await getDb().insert(encounters).values({
      patientId: PID, encounterType: 'opd', encounterDate: '2099-01-01', providerId, checkedInByName: 'TEST-SP3', ...v,
    }).returning()
    ids.encounters.push(r.id)
    return r
  }

  async function insertOrder(v: Partial<typeof followUpOrders.$inferInsert>) {
    const { getDb } = await import('@/db/client')
    const [r] = await getDb().insert(followUpOrders).values({
      patientId: PID, source: 'manual', prescribedByProviderId: providerId, baseDate: '2099-01-01',
      dueDate: '2099-01-10', windowStart: '2099-01-07', windowEnd: '2099-01-17', reason: 'Review', createdByName: 'TEST-SP3', ...v,
    }).returning()
    ids.orders.push(r.id)
    return r
  }

  it('rejects a second encounter with the same date and token, allows NULL tokens', async () => {
    const { isUniqueViolation } = await import('@/lib/db-errors')
    const first = await insertEncounter({ opdToken: 1 })
    expect(first.status).toBe('checked_in')
    expect(first.visitType).toBe('new')
    const err = await errorOf(insertEncounter({ opdToken: 1 }))
    expect(isUniqueViolation(err, 'encounters_date_token_unique')).toBe(true)
    await insertEncounter({ opdToken: null })
    await insertEncounter({ opdToken: null })
  })

  it('rejects a non-positive OPD token', async () => {
    const { pgErrorCode, pgConstraint } = await import('@/lib/db-errors')
    const err = await errorOf(insertEncounter({ opdToken: 0 }))
    expect(pgErrorCode(err)).toBe('23514')
    expect(pgConstraint(err)).toBe('encounters_token_positive')
  })

  it('rejects a window that does not contain the due date', async () => {
    const { pgErrorCode, pgConstraint } = await import('@/lib/db-errors')
    const err = await errorOf(insertOrder({ dueDate: '2099-01-10', windowStart: '2099-01-11', windowEnd: '2099-01-20' }))
    expect(pgErrorCode(err)).toBe('23514')
    expect(pgConstraint(err)).toBe('follow_up_orders_window_order')
  })

  it('rejects an unpaired or non-positive interval, and a cancel without a reason', async () => {
    const { pgConstraint } = await import('@/lib/db-errors')
    expect(pgConstraint(await errorOf(insertOrder({ intervalValue: 2 })))).toBe('follow_up_orders_interval_pair')
    expect(pgConstraint(await errorOf(insertOrder({ intervalValue: 0, intervalUnit: 'weeks' })))).toBe('follow_up_orders_interval_pair')
    expect(pgConstraint(await errorOf(insertOrder({ status: 'cancelled' })))).toBe('follow_up_orders_cancel_reason')
    const ok = await insertOrder({ intervalValue: 2, intervalUnit: 'weeks' })
    expect(ok.status).toBe('planned')
  })

  it('deleting an order cascades its contact attempts; deleting its appointment nulls the link', async () => {
    const { getDb } = await import('@/db/client')
    const { appointments } = await import('@/db/schema')
    const { eq } = await import('drizzle-orm')
    const db = getDb()
    const [appt] = await db.insert(appointments).values({
      patientId: PID, providerId, startsAt: new Date('2099-01-10T04:00:00Z'), endsAt: new Date('2099-01-10T04:15:00Z'), visitReason: 'TEST-SP3',
    }).returning()
    ids.appointments.push(appt.id)
    const enc = await insertEncounter({ appointmentId: appt.id })
    const order = await insertOrder({ appointmentId: appt.id, status: 'scheduled', originatingEncounterId: enc.id })
    const [attempt] = await db.insert(followUpContactAttempts).values({
      followUpOrderId: order.id, channel: 'phone', outcome: 'no_answer', attemptedByName: 'TEST-SP3',
    }).returning()
    ids.attempts.push(attempt.id)

    // Appointment delete: both links go null, rows survive.
    await db.delete(appointments).where(eq(appointments.id, appt.id))
    ids.appointments.splice(0)
    const [o] = await db.select().from(followUpOrders).where(eq(followUpOrders.id, order.id))
    expect(o.appointmentId).toBeNull()
    const [e] = await db.select().from(encounters).where(eq(encounters.id, enc.id))
    expect(e.appointmentId).toBeNull()

    // Encounter delete: provenance link goes null.
    await db.delete(encounters).where(eq(encounters.id, enc.id))
    ids.encounters.splice(ids.encounters.indexOf(enc.id), 1)
    const [o2] = await db.select().from(followUpOrders).where(eq(followUpOrders.id, order.id))
    expect(o2.originatingEncounterId).toBeNull()

    // Order delete cascades its attempts.
    await db.delete(followUpOrders).where(eq(followUpOrders.id, order.id))
    ids.orders.splice(ids.orders.indexOf(order.id), 1)
    const left = await db.select().from(followUpContactAttempts).where(eq(followUpContactAttempts.id, attempt.id))
    expect(left).toEqual([])
    ids.attempts.splice(0)
  })

  it('deletePatient removes the patient\'s encounters, follow-ups and contact attempts', { timeout: 30000 }, async () => {
    const { getDb } = await import('@/db/client')
    const { patients } = await import('@/db/schema')
    const { deletePatient } = await import('@/lib/queries/patients')
    const { eq } = await import('drizzle-orm')
    const db = getDb()
    const enc = await insertEncounter({ opdToken: null })
    const order = await insertOrder({ originatingEncounterId: enc.id, completedEncounterId: enc.id })
    const [attempt] = await db.insert(followUpContactAttempts).values({
      followUpOrderId: order.id, channel: 'phone', outcome: 'no_answer', attemptedByName: 'TEST-SP3',
    }).returning()
    ids.attempts.push(attempt.id)

    expect(await deletePatient(PID)).toBe(true)
    expect(await db.select().from(patients).where(eq(patients.id, PID))).toEqual([])
    expect(await db.select().from(encounters).where(eq(encounters.patientId, PID))).toEqual([])
    expect(await db.select().from(followUpOrders).where(eq(followUpOrders.patientId, PID))).toEqual([])
    expect(await db.select().from(followUpContactAttempts).where(eq(followUpContactAttempts.id, attempt.id))).toEqual([])
  })

  it('rejects a contact note over 500 characters', async () => {
    const { getDb } = await import('@/db/client')
    const { pgConstraint } = await import('@/lib/db-errors')
    const order = await insertOrder({})
    const err = await errorOf(getDb().insert(followUpContactAttempts).values({
      followUpOrderId: order.id, channel: 'sms', outcome: 'message_left', note: 'x'.repeat(501), attemptedByName: 'TEST-SP3',
    }))
    expect(pgConstraint(err)).toBe('follow_up_contact_attempts_note_len')
  })
})
