// Wave G P2-01: per-user read state for the staff notification feed.
import { describe, it, expect, afterAll } from 'vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { staffNotificationReads } from '@/db/schema'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

const FILE = '2026-10-09-wave-g-staff-notification-reads.sql'

describe('staff_notification_reads schema', () => {
  it('migration is idempotent, additive and covers every column', () => {
    const sqlText = readMigration(FILE)
    expect(idempotencyProblems(sqlText)).toEqual([])
    expect(missingColumns(staffNotificationReads, sqlText)).toEqual([])
  })

  it('is keyed by (user_key, item_key) so marking read twice is a no-op', () => {
    const cfg = getTableConfig(staffNotificationReads)
    expect(cfg.name).toBe('staff_notification_reads')
    expect(cfg.primaryKeys.map((pk) => pk.columns.map((c) => c.name))).toEqual([['user_key', 'item_key']])
    expect(readMigration(FILE)).toMatch(/PRIMARY KEY \(user_key, item_key\)/)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('staff_notification_reads (DB)', () => {
  const USER = `test-wg-${Date.now()}`
  afterAll(async () => {
    const { getDb } = await import('@/db/client')
    const { eq } = await import('drizzle-orm')
    await getDb().delete(staffNotificationReads).where(eq(staffNotificationReads.userKey, USER))
  })
  it('exists in the database and rejects a duplicate key', async () => {
    const { getDb } = await import('@/db/client')
    const db = getDb()
    await db.insert(staffNotificationReads).values({ userKey: USER, itemKey: 'lab_report:1' })
    await expect(db.insert(staffNotificationReads).values({ userKey: USER, itemKey: 'lab_report:1' })).rejects.toThrow()
    const again = await db.insert(staffNotificationReads).values({ userKey: USER, itemKey: 'lab_report:1' }).onConflictDoNothing().returning()
    expect(again).toEqual([])
  })
})
