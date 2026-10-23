import { describe, it, expect, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import pg from 'pg'
import { getDb } from '@/db/client'
import { sslFor } from '@/db/url'
import { brandSettings, brandAssets } from '@/db/schema'
import { BRAND_ASSET_KINDS, BRAND_EDITABLE_KEYS } from '@/lib/brand-snapshot'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

// WL T3: brand_settings (singleton) and brand_assets (spec §3, lane rulings R1-R3). The migration
// matches src/db/schema.ts, is re-runnable, and every rule is a named CHECK.
const M = '2026-10-27-wl-brand-settings.sql'
const TABLES = [brandSettings, brandAssets] as const

const constraintNames = (t: (typeof TABLES)[number]) => {
  const c = getTableConfig(t)
  return [...c.foreignKeys.map((f) => f.getName()), ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!)]
}

describe('WL brand settings migration (static)', () => {
  it('is idempotent, declares every column and names every constraint', () => {
    const s = readMigration(M)
    expect(idempotencyProblems(s)).toEqual([])
    for (const t of TABLES) {
      expect(missingColumns(t, s)).toEqual([])
      for (const n of constraintNames(t)) { expect(n.length, n).toBeLessThanOrEqual(63); expect(s, n).toContain(n) }
    }
    expect(s).toMatch(/INSERT INTO brand_settings \(id\) VALUES \(1\) ON CONFLICT DO NOTHING;/)
  })

  it('has no login background or welcome line (R2) and the R2/R3 columns and kinds', () => {
    const s = readMigration(M)
    expect(s).not.toMatch(/login_background|login_welcome/)
    const cols = getTableConfig(brandSettings).columns.map((c) => c.name)
    for (const c of ['login_quote', 'login_quote_attribution', 'logo_url']) expect(cols).toContain(c)
    expect(BRAND_ASSET_KINDS).toEqual(['logo_light', 'logo_dark', 'icon_32', 'icon_180', 'icon_192', 'icon_512'])
    expect(s).toContain(`kind IN (${BRAND_ASSET_KINDS.map((k) => `'${k}'`).join(', ')})`)
    expect(BRAND_EDITABLE_KEYS).toEqual([
      'displayName', 'tagline', 'supportEmail', 'supportPhone', 'accentColor', 'logoUrl', 'loginQuote', 'loginQuoteAttribution',
      'loginShowDepartmentList', 'portalName', 'printHeaderText', 'printFooterText', 'printSignatureLine', 'emailSignature', 'smsName',
    ])
  })

  it('neither table references patients or users (seed clearExistingData keeps them, like billing_settings)', () => {
    for (const t of TABLES) expect(getTableConfig(t).foreignKeys).toEqual([])
  })
})

describe.skipIf(!process.env.DATABASE_URL)('WL brand settings (DB)', () => {
  const db = () => getDb()
  const constraintOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try { await p } catch (e) { return (e as { cause?: { constraint?: string } }).cause?.constraint }
    return undefined
  }

  afterEach(async () => {
    const { resetBrandSettings } = await import('@/lib/queries/brand-settings')
    await resetBrandSettings(null)
  })

  it('the live tables have the schema.ts columns and constraints', async () => {
    for (const t of TABLES) {
      const c = getTableConfig(t)
      const cols = await db().execute<{ column_name: string; is_nullable: string }>(sql`
        select column_name, is_nullable from information_schema.columns where table_name = ${c.name} order by column_name`)
      expect(cols.rows.map((r) => `${r.column_name}:${r.is_nullable}`)).toEqual(
        c.columns.map((col) => `${col.name}:${col.notNull || col.primary ? 'NO' : 'YES'}`).sort())
      const cons = await db().execute<{ conname: string }>(sql`
        select conname from pg_constraint where conrelid = ${c.name}::regclass and contype in ('c', 'f', 'u')`)
      expect(cons.rows.map((r) => r.conname).sort()).toEqual(constraintNames(t).sort())
    }
  })

  it('after the migration the singleton exists with revision 0 and the department list shown', async () => {
    const r = await db().execute<{ id: number; revision: number; login_show_department_list: boolean }>(sql`
      select id, revision, login_show_department_list from brand_settings`)
    expect(r.rows).toEqual([{ id: 1, revision: 0, login_show_department_list: true }])
  })

  it('a second row fails brand_settings_singleton', async () => {
    expect(await constraintOf(db().execute(sql`insert into brand_settings (id) values (2)`))).toBe('brand_settings_singleton')
  })

  it.each([
    ['accent_color', '#FFF', 'brand_settings_accent_color_format'],
    ['accent_color', '#ABCDEF', 'brand_settings_accent_color_format'],
    ['display_name', 'x'.repeat(61), 'brand_settings_display_name_length'],
    ['login_quote', 'q'.repeat(201), 'brand_settings_login_quote_length'],
    ['login_quote_attribution', 'a'.repeat(101), 'brand_settings_login_quote_attribution_length'],
    ['logo_url', `https://example.in/${'l'.repeat(2048)}`, 'brand_settings_logo_url_length'],
    ['support_email', 'not an email', 'brand_settings_support_email_format'],
    ['support_phone', '12345', 'brand_settings_support_phone_format'],
    ['email_signature', 'a\nb\nc\nd\ne', 'brand_settings_email_signature_length'],
    ['sms_name', 's'.repeat(31), 'brand_settings_sms_name_length'],
  ])('%s = %j fails %s', async (col, value, name) => {
    expect(await constraintOf(db().execute(sql`update brand_settings set ${sql.identifier(col)} = ${value} where id = 1`))).toBe(name)
  })

  it('accepts valid values at each limit', async () => {
    await db().execute(sql`update brand_settings set accent_color = '#0a7c86', display_name = ${'x'.repeat(60)},
      login_quote = ${'q'.repeat(200)}, support_email = 'help@sunrise-hospital.in', support_phone = '+91 80 4000 1234',
      email_signature = ${'a\nb\nc\nd'} where id = 1`)
    const r = await db().execute<{ accent_color: string }>(sql`select accent_color from brand_settings where id = 1`)
    expect(r.rows[0].accent_color).toBe('#0a7c86')
  })

  it("brand_assets.kind = 'banner' fails brand_assets_kind_valid", async () => {
    expect(await constraintOf(db().execute(sql`
      insert into brand_assets (kind, source, blob_url, sha256, content_type, width, height, byte_size, created_by_name)
      values ('banner', 'upload', 'local:x', ${'a'.repeat(64)}, 'image/png', 10, 10, 10, 'TEST-WL')`))).toBe('brand_assets_kind_valid')
  })

  it('running the migration file twice succeeds (re-runnable) and keeps the singleton', async () => {
    const text = readMigration(M)
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: sslFor(process.env.DATABASE_URL!) })
    await c.connect()
    try {
      await c.query(text)
      await c.query(text)
    } finally {
      await c.end()
    }
    const r = await db().execute<{ n: number }>(sql`select count(*)::int as n from brand_settings`)
    expect(r.rows[0].n).toBe(1)
  })
})
