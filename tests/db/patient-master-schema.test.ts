import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { patients, patientContacts, patientAadhaar, providers, appSettings } from '@/db/schema'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

const MIGRATION = '2026-10-07-sp1-patient-master.sql'

describe('patient master schema', () => {
  it('migration is idempotent', () => {
    expect(idempotencyProblems(readMigration(MIGRATION))).toEqual([])
  })

  // patients/providers/app_settings existed before SP1 (created by db:push, not
  // by any migration file), so their legacy columns never appear in this SQL.
  // Frozen snapshot of each table's columns as of commit 4961454 (pre-Task 3):
  // every column NOT in this list must be declared by this migration. Adding a
  // column to schema.ts without adding it to the migration therefore fails.
  const PRE_SP1_COLUMNS: Record<string, string[]> = {
    patients: [
      'id', 'date_added', 'name', 'dob', 'city', 'zip', 'phone', 'email', 'current_provider', 'rating_scales',
      'referral_type', 'availability', 'last_appt_date', 'next_appt_date', 'comm_consent_signed', 'comm_consent_pref',
      'template_doc_url', 'prescreening_sent_date', 'portal_password_hash', 'last_communication', 'form_notes',
      'reviewer_notes', 'clinician_reviewer_notes', 'pi_recommendation', 'old_notes', 'old_recs',
      'outside_meds_confirmation', 'chart_data_as_of', 'mfa_secret_encrypted', 'mfa_enabled', 'primary_payer_id',
      'primary_member_id', 'primary_group_number', 'primary_plan_type', 'primary_subscriber_name',
      'primary_subscriber_relationship', 'primary_card_front_url', 'primary_card_back_url', 'secondary_payer_id',
      'secondary_member_id', 'secondary_group_number', 'secondary_plan_type', 'secondary_subscriber_name',
      'secondary_subscriber_relationship',
    ],
    providers: ['id', 'name', 'credentials', 'specialty', 'color_tag', 'is_active', 'created_at'],
    app_settings: [
      'id', 'auto_classify_on_complete', 'practice_name', 'practice_site', 'practice_timezone',
      'admin_mfa_secret_encrypted', 'admin_mfa_enabled', 'admin_mfa_method', 'admin_phone', 'queue_display_pin',
    ],
    patient_contacts: [],
    patient_aadhaar: [],
  }

  it.each([
    ['patients', patients],
    ['patient_contacts', patientContacts],
    ['patient_aadhaar', patientAadhaar],
    ['providers', providers],
    ['app_settings', appSettings],
  ] as const)('migration declares every new %s column', (n, t) => {
    const legacy = PRE_SP1_COLUMNS[n]
    const columns = getTableConfig(t).columns.map((c) => c.name)
    // The baseline must not exempt anything that no longer exists, and the table must have something new.
    expect(legacy.filter((c) => !columns.includes(c))).toEqual([])
    expect(columns.length).toBeGreaterThan(legacy.length)
    expect(missingColumns(t, readMigration(MIGRATION)).filter((c) => !legacy.includes(c))).toEqual([])
  })

  it('missingColumns-based check catches a new column left out of the SQL', () => {
    const withoutMlc = readMigration(MIGRATION).replace(/mlc_number/g, 'x')
    expect(missingColumns(patients, withoutMlc)).toContain('mlc_number')
  })

  it('keeps Aadhaar off the patients table', () => {
    expect(getTableConfig(patients).columns.map((c) => c.name).filter((n) => /aadhaar/i.test(n))).toEqual([])
  })

  it('migration creates uhid_seq, the xor check and the three unique constraints', () => {
    const s = readMigration(MIGRATION)
    for (const needle of [
      'uhid_seq', 'patient_aadhaar_value_xor_decline', 'patients_uhid_unique', 'patients_abha_number_unique',
      'patients_abha_address_unique', "ADD VALUE IF NOT EXISTS 'voter_id'", "ADD VALUE IF NOT EXISTS 'pan'",
      "ADD VALUE IF NOT EXISTS 'ration_card'", "SET DEFAULT 'Asia/Kolkata'", 'providers_consultation_fee_nonneg',
    ]) expect(s).toContain(needle)
  })

  it('schema declares the named constraints the migration creates', () => {
    const p = getTableConfig(patients)
    const uniqueNames = p.columns.filter((c) => c.isUnique).map((c) => c.uniqueName)
    expect(uniqueNames).toEqual(expect.arrayContaining(['patients_uhid_unique', 'patients_abha_number_unique', 'patients_abha_address_unique']))
    expect(getTableConfig(patientAadhaar).checks.map((c) => c.name)).toEqual(['patient_aadhaar_value_xor_decline'])
    expect(getTableConfig(providers).checks.map((c) => c.name)).toEqual(['providers_consultation_fee_nonneg'])
  })

  it('deletePatient and clearExistingData clear the new child tables', () => {
    for (const f of ['src/lib/queries/patients.ts', 'src/db/seed.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect(src).toContain('patientContacts')
      expect(src).toContain('patientAadhaar')
      // children before the patients delete
      const parent = f.endsWith('seed.ts') ? 'await db.delete(patients)' : 'await db.delete(patients).where'
      expect(src.indexOf('db.delete(patientContacts)')).toBeGreaterThan(-1)
      expect(src.indexOf('db.delete(patientAadhaar)')).toBeGreaterThan(-1)
      expect(src.indexOf('db.delete(patientContacts)')).toBeLessThan(src.indexOf(parent))
      expect(src.indexOf('db.delete(patientAadhaar)')).toBeLessThan(src.indexOf(parent))
    }
  })
})

describe.skipIf(!process.env.DATABASE_URL)('patient master (DB)', () => {
  const PID = 'TEST-SP1-X'
  afterEach(async () => {
    const { getDb } = await import('@/db/client')
    const { eq } = await import('drizzle-orm')
    const db = getDb()
    await db.delete(patientAadhaar).where(eq(patientAadhaar.patientId, PID))
    await db.delete(patients).where(eq(patients.id, PID))
  })

  it('rejects a patient_aadhaar row with both a value and a decline reason', async () => {
    const { getDb } = await import('@/db/client')
    const { pgErrorCode } = await import('@/lib/db-errors')
    const db = getDb()
    await db.insert(patients).values({ id: PID, name: 'Test SP1 X', dob: '1990-01-01' })
    let err: unknown
    try {
      await db.insert(patientAadhaar).values({
        patientId: PID, aadhaarEncrypted: 'ciphertext', aadhaarLast4: '1234', consentGiven: true,
        declineReason: 'patient_declined', recordedByName: 'Test',
      })
    } catch (e) { err = e }
    expect(pgErrorCode(err)).toBe('23514')
  })
})
