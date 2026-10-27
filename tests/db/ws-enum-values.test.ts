// WS1/WS2 T1: the enum values added for the encounter note signature and automatic charge capture.
import { describe, it, expect } from 'vitest'
import { chargeLineSourceEnum, signableTypeEnum } from '@/db/schema'
import { readMigration } from './migration-sql'

const WS1 = '2026-10-24-ws1-0-enum-values.sql'
const WS2 = '2026-10-24-ws2-0-enum-values.sql'
const code = (s: string) => s.replace(/--[^\n]*/g, '').split('\n').map((l) => l.trim()).filter(Boolean)

describe('WS1/WS2 enum values', () => {
  it('the drizzle arrays equal the migration result (new values last)', () => {
    expect(signableTypeEnum.enumValues).toEqual(['form_submission', 'admission_discharge', 'policy_acceptance', 'form_submission_consent', 'encounter_note'])
    expect(chargeLineSourceEnum.enumValues).toEqual(['manual', 'room_rent', 'pharmacy', 'registration', 'consultation', 'lab_order', 'procedure'])
  })

  it('the migrations hold only ADD VALUE IF NOT EXISTS lines inside BEGIN/COMMIT', () => {
    expect(code(readMigration(WS1))).toEqual([
      'BEGIN;',
      "ALTER TYPE signable_type ADD VALUE IF NOT EXISTS 'encounter_note' AFTER 'form_submission_consent';",
      'COMMIT;',
    ])
    expect(code(readMigration(WS2))).toEqual([
      'BEGIN;',
      "ALTER TYPE charge_line_source ADD VALUE IF NOT EXISTS 'registration' AFTER 'pharmacy';",
      "ALTER TYPE charge_line_source ADD VALUE IF NOT EXISTS 'consultation' AFTER 'registration';",
      "ALTER TYPE charge_line_source ADD VALUE IF NOT EXISTS 'lab_order' AFTER 'consultation';",
      "ALTER TYPE charge_line_source ADD VALUE IF NOT EXISTS 'procedure' AFTER 'lab_order';",
      'COMMIT;',
    ])
  })
})

describe.skipIf(!process.env.DATABASE_URL)('WS1/WS2 enum values (DB)', () => {
  it('the database enum order equals the drizzle arrays', async () => {
    const { getDb } = await import('@/db/client')
    const { sql } = await import('drizzle-orm')
    const res = await getDb().execute(sql`SELECT enum_range(NULL::signable_type)::text[] AS s, enum_range(NULL::charge_line_source)::text[] AS c`)
    const row = (res as unknown as { rows: Array<{ s: string[]; c: string[] }> }).rows[0]
    expect(row.s).toEqual([...signableTypeEnum.enumValues])
    expect(row.c).toEqual([...chargeLineSourceEnum.enumValues])
  })
})
