import { describe, it, expect, afterAll } from 'vitest'
import { inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { formatUhid, parseUhid } from '@/lib/uhid'
import { getUhidPrefix } from '@/lib/queries/uhid'
import { readMigration, idempotencyProblems } from './migration-sql'

const FILE = '2026-10-09-uhid-backfill.sql'

describe('UHID backfill migration (static)', () => {
  it('is wrapped in one transaction and is idempotent and non-destructive', () => {
    expect(idempotencyProblems(readMigration(FILE))).toEqual([])
  })

  it('only fills UHIDs that are missing (never rewrites an issued one)', () => {
    const text = readMigration(FILE)
    expect(text).toMatch(/WHERE\s+(p\.)?uhid\s+IS\s+NULL/i)
    expect(text).not.toMatch(/SET\s+uhid\s*=\s*NULL/i)
  })
})

// Applies the real migration to the database twice. It fills every patient that has no UHID
// (that is the migration's job), so it is only safe against a worktree's own database.
describe.skipIf(!process.env.DATABASE_URL)('UHID backfill migration (DB)', () => {
  const tag = `UHBF-${Date.now()}`
  const ids = [`${tag}-a`, `${tag}-b`, `${tag}-c`]

  afterAll(async () => {
    await getDb().delete(patients).where(inArray(patients.id, ids))
  })

  async function apply() {
    await getDb().execute(sql.raw(readMigration(FILE)))
  }

  async function uhidsOf(): Promise<Map<string, string | null>> {
    const rows = await getDb().select({ id: patients.id, uhid: patients.uhid }).from(patients).where(inArray(patients.id, ids))
    return new Map(rows.map((r) => [r.id, r.uhid]))
  }

  it('gives every patient without a UHID a valid, unique one, skips numbers already issued, and is a no-op the second time', async () => {
    const db = getDb()
    const prefix = await getUhidPrefix()
    // A UHID issued by hand ahead of the sequence: the backfill must never collide with it.
    const [{ seq }] = (await db.execute(sql`select last_value::int as seq from uhid_seq`)).rows as { seq: number }[]
    const ahead = formatUhid(prefix, seq + 2)
    await db.insert(patients).values([
      { id: ids[0], name: 'Backfill Test A', dob: '1990-01-01' },
      { id: ids[1], name: 'Backfill Test B', dob: '1991-01-01' },
      { id: ids[2], name: 'Backfill Test C', dob: '1992-01-01', uhid: ahead },
    ])

    await apply()
    const first = await uhidsOf()
    const a = first.get(ids[0])!
    const b = first.get(ids[1])!
    expect(parseUhid(a)?.prefix).toBe(prefix)
    expect(parseUhid(b)?.prefix).toBe(prefix)
    expect(a).not.toBe(b)
    expect(first.get(ids[2])).toBe(ahead)
    expect([a, b]).not.toContain(ahead)

    const [{ missing }] = (await db.execute(sql`select count(*)::int as missing from patients where uhid is null`)).rows as { missing: number }[]
    expect(missing).toBe(0)

    await apply()
    expect(await uhidsOf()).toEqual(first)
  })
})
