import { describe, it, expect } from 'vitest'
import { sql, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'

// Snapshot captured live, immediately before the Task 1 migration ran
// (2026-09-29), via a read-only query selecting every patient's id,
// nameTebra/nameIntakeq, dobTebra/dobIntakeq (and the same pair for
// city/zip/phone/email) and computing `tebra ?? intakeq` for each -- the
// exact precedence every read path in the app used before this migration.
// This is the one guarantee the whole migration exists to make: no
// patient's displayed identity silently changed as a result of collapsing
// the dual-sourced columns into single fields (see docs/superpowers/specs/
// 2026-09-29-unified-patient-record.md §5, §6).
//
// Five of these ids (RD-0055, RD-0056, RD-0057, RD-0059, RD-0060) are
// ephemeral fixtures created/deleted by other test suites against this
// same shared live DB and may not exist by the time this test runs --
// the per-row assertion below only runs against ids that are still
// present, and a floor on how many of the 58 were found guards against
// the query itself silently returning nothing.
const PRE_MIGRATION_SNAPSHOT: {
  id: string
  expectedName: string
  expectedDob: string
  expectedCity: string | null
  expectedZip: string | null
  expectedPhone: string | null
  expectedEmail: string | null
}[] = [
  { id: 'RD-0001', expectedName: 'Maria Alvarez', expectedDob: '1985-03-12', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0142', expectedEmail: 'maria.alvarez.demo@example.com' },
  { id: 'RD-0002', expectedName: 'James Thornton', expectedDob: '1990-11-02', expectedCity: 'Highland', expectedZip: '92346', expectedPhone: '909-555-0198', expectedEmail: 'jthornton.demo@example.com' },
  { id: 'RD-0003', expectedName: 'Linda Cho', expectedDob: '1978-06-30', expectedCity: 'Yucaipa', expectedZip: '92399', expectedPhone: '909-555-0177', expectedEmail: 'lcho.demo@example.com' },
  { id: 'RD-0004', expectedName: 'Priya Natarajan', expectedDob: '1994-02-18', expectedCity: 'Redlands', expectedZip: '92374', expectedPhone: '909-555-0133', expectedEmail: 'pnatarajan.demo@example.com' },
  { id: 'RD-0005', expectedName: 'Marcus Webb', expectedDob: '1988-09-09', expectedCity: 'Loma Linda', expectedZip: '92354', expectedPhone: '909-555-0161', expectedEmail: 'mwebb.demo@example.com' },
  { id: 'RD-0006', expectedName: 'Kathryn Voss', expectedDob: '1982-12-05', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0188', expectedEmail: 'kvoss.old@example.com' },
  { id: 'RD-0007', expectedName: 'Robert Nguyen', expectedDob: '1980-01-10', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0200', expectedEmail: 'robert.nguyen.demo@example.com' },
  { id: 'RD-0008', expectedName: 'Angela Ferraro', expectedDob: '1981-02-11', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0201', expectedEmail: 'angela.ferraro.demo@example.com' },
  { id: 'RD-0009', expectedName: 'Devon Okafor', expectedDob: '1982-03-12', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0202', expectedEmail: 'devon.okafor.demo@example.com' },
  { id: 'RD-0010', expectedName: 'Sana Patel', expectedDob: '1983-04-13', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0203', expectedEmail: 'sana.patel.demo@example.com' },
  { id: 'RD-0011', expectedName: 'Wesley Turner', expectedDob: '1984-05-14', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0204', expectedEmail: 'wesley.turner.demo@example.com' },
  { id: 'RD-0012', expectedName: 'Isabel Marquez', expectedDob: '1985-06-15', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0205', expectedEmail: 'isabel.marquez.demo@example.com' },
  { id: 'RD-0013', expectedName: 'Owen Fitzgerald', expectedDob: '1986-07-16', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0206', expectedEmail: 'owen.fitzgerald.demo@example.com' },
  { id: 'RD-0014', expectedName: 'Grace Kim', expectedDob: '1987-08-17', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0207', expectedEmail: 'grace.kim.demo@example.com' },
  { id: 'RD-0015', expectedName: 'Tobias Reyes', expectedDob: '1988-09-18', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0208', expectedEmail: 'tobias.reyes.demo@example.com' },
  { id: 'RD-0016', expectedName: 'Nadia Suleiman', expectedDob: '1989-01-10', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0209', expectedEmail: 'nadia.suleiman.demo@example.com' },
  { id: 'RD-0017', expectedName: 'Colin Brantley', expectedDob: '1990-02-11', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0210', expectedEmail: 'colin.brantley.demo@example.com' },
  { id: 'RD-0018', expectedName: 'Fatima Rashid', expectedDob: '1991-03-12', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0211', expectedEmail: 'fatima.rashid.demo@example.com' },
  { id: 'RD-0019', expectedName: 'Geet vardhan ', expectedDob: '2005-05-10', expectedCity: null, expectedZip: null, expectedPhone: null, expectedEmail: null },
  { id: 'RD-0020', expectedName: 'Priya Chandrasekaran', expectedDob: '1996-02-13', expectedCity: 'Redlands', expectedZip: '92374', expectedPhone: '909-555-0313', expectedEmail: 'priya.chandrasekaran.demo@example.com' },
  { id: 'RD-0021', expectedName: 'Diego Salgado', expectedDob: '2003-03-16', expectedCity: 'Highland', expectedZip: '92346', expectedPhone: '909-555-0314', expectedEmail: 'diego.salgado.demo@example.com' },
  { id: 'RD-0022', expectedName: 'Yasmin Haddad', expectedDob: '1960-04-19', expectedCity: 'Yucaipa', expectedZip: '92399', expectedPhone: '909-555-0315', expectedEmail: 'yasmin.haddad.demo@example.com' },
  { id: 'RD-0023', expectedName: 'Trevor Osei', expectedDob: '1967-05-22', expectedCity: 'Loma Linda', expectedZip: '92354', expectedPhone: '909-555-0316', expectedEmail: 'trevor.osei.demo@example.com' },
  { id: 'RD-0024', expectedName: 'Lena Kowalski', expectedDob: '1974-06-25', expectedCity: 'San Bernardino', expectedZip: '92404', expectedPhone: '909-555-0317', expectedEmail: 'lena.kowalski.demo@example.com' },
  { id: 'RD-0025', expectedName: 'Anthony Delgado', expectedDob: '1981-07-01', expectedCity: 'Riverside', expectedZip: '92501', expectedPhone: '909-555-0318', expectedEmail: 'anthony.delgado.demo@example.com' },
  { id: 'RD-0026', expectedName: 'Rina Fujimoto', expectedDob: '1988-08-04', expectedCity: 'Colton', expectedZip: '92324', expectedPhone: '909-555-0319', expectedEmail: 'rina.fujimoto.demo@example.com' },
  { id: 'RD-0027', expectedName: 'Samuel Okonkwo', expectedDob: '1995-09-07', expectedCity: 'Rialto', expectedZip: '92376', expectedPhone: '909-555-0320', expectedEmail: 'samuel.okonkwo.demo@example.com' },
  { id: 'RD-0028', expectedName: 'Chloe Bergstrom', expectedDob: '2002-10-10', expectedCity: 'Beaumont', expectedZip: '92223', expectedPhone: '909-555-0321', expectedEmail: 'chloe.bergstrom.demo@example.com' },
  { id: 'RD-0029', expectedName: 'Amir Farouk', expectedDob: '1959-11-13', expectedCity: 'Banning', expectedZip: '92220', expectedPhone: '909-555-0322', expectedEmail: 'amir.farouk.demo@example.com' },
  { id: 'RD-0030', expectedName: 'Danielle Whitfield', expectedDob: '1966-12-16', expectedCity: 'Calimesa', expectedZip: '92320', expectedPhone: '909-555-0323', expectedEmail: 'danielle.whitfield.demo@example.com' },
  { id: 'RD-0031', expectedName: 'Hassan Malik', expectedDob: '1973-01-19', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0324', expectedEmail: 'hassan.malik.demo@example.com' },
  { id: 'RD-0032', expectedName: 'Sophia Papadakis', expectedDob: '1980-02-22', expectedCity: 'Redlands', expectedZip: '92374', expectedPhone: '909-555-0325', expectedEmail: 'sophia.papadakis.demo@example.com' },
  { id: 'RD-0033', expectedName: 'Elijah Cross', expectedDob: '1987-03-25', expectedCity: 'Highland', expectedZip: '92346', expectedPhone: '909-555-0326', expectedEmail: 'elijah.cross.demo@example.com' },
  { id: 'RD-0034', expectedName: 'Mei Lin Tan', expectedDob: '1994-04-01', expectedCity: 'Yucaipa', expectedZip: '92399', expectedPhone: '909-555-0327', expectedEmail: 'mei.lin.demo@example.com' },
  { id: 'RD-0035', expectedName: 'Gabriel Ontiveros', expectedDob: '2001-05-04', expectedCity: 'Loma Linda', expectedZip: '92354', expectedPhone: '909-555-0328', expectedEmail: 'gabriel.ontiveros.demo@example.com' },
  { id: 'RD-0036', expectedName: 'Renee Castellano', expectedDob: '1958-06-07', expectedCity: 'San Bernardino', expectedZip: '92404', expectedPhone: '909-555-0329', expectedEmail: 'renee.castellano.demo@example.com' },
  { id: 'RD-0037', expectedName: 'Kwame Asante', expectedDob: '1965-07-10', expectedCity: 'Riverside', expectedZip: '92501', expectedPhone: '909-555-0330', expectedEmail: 'kwame.asante.demo@example.com' },
  { id: 'RD-0038', expectedName: 'Ingrid Solheim', expectedDob: '1972-08-13', expectedCity: 'Colton', expectedZip: '92324', expectedPhone: '909-555-0331', expectedEmail: 'ingrid.solheim.demo@example.com' },
  { id: 'RD-0039', expectedName: 'Julian Restrepo', expectedDob: '1979-09-16', expectedCity: 'Rialto', expectedZip: '92376', expectedPhone: '909-555-0332', expectedEmail: 'julian.restrepo.demo@example.com' },
  { id: 'RD-0040', expectedName: 'Aaliyah Jefferson', expectedDob: '1986-10-19', expectedCity: 'Beaumont', expectedZip: '92223', expectedPhone: '909-555-0333', expectedEmail: 'aaliyah.jefferson.demo@example.com' },
  { id: 'RD-0041', expectedName: 'Noah Feldman', expectedDob: '1993-11-22', expectedCity: 'Banning', expectedZip: '92220', expectedPhone: '909-555-0334', expectedEmail: 'noah.feldman.demo@example.com' },
  { id: 'RD-0042', expectedName: 'Camille Dubois', expectedDob: '2000-12-25', expectedCity: 'Calimesa', expectedZip: '92320', expectedPhone: '909-555-0335', expectedEmail: 'camille.dubois.demo@example.com' },
  { id: 'RD-0043', expectedName: 'Tariq Abbasi', expectedDob: '1957-01-01', expectedCity: 'Redlands', expectedZip: '92373', expectedPhone: '909-555-0336', expectedEmail: 'tariq.abbasi.demo@example.com' },
  { id: 'RD-0044', expectedName: 'Whitney Sorensen', expectedDob: '1964-02-04', expectedCity: 'Redlands', expectedZip: '92374', expectedPhone: '909-555-0337', expectedEmail: 'whitney.sorensen.demo@example.com' },
  { id: 'RD-0045', expectedName: 'Mateo Villareal', expectedDob: '1971-03-07', expectedCity: 'Highland', expectedZip: '92346', expectedPhone: '909-555-0338', expectedEmail: 'mateo.villareal.demo@example.com' },
  { id: 'RD-0046', expectedName: 'Simone Achebe', expectedDob: '1978-04-10', expectedCity: 'Yucaipa', expectedZip: '92399', expectedPhone: '909-555-0339', expectedEmail: 'simone.achebe.demo@example.com' },
  { id: 'RD-0047', expectedName: 'Declan O’Farrell', expectedDob: '1985-05-13', expectedCity: 'Loma Linda', expectedZip: '92354', expectedPhone: '909-555-0340', expectedEmail: 'declan.ofarrell.demo@example.com' },
  { id: 'RD-0048', expectedName: 'Priyanka Deshmukh', expectedDob: '1992-06-16', expectedCity: 'San Bernardino', expectedZip: '92404', expectedPhone: '909-555-0341', expectedEmail: 'priyanka.deshmukh.demo@example.com' },
  { id: 'RD-0049', expectedName: 'Zachary Huang', expectedDob: '1999-07-19', expectedCity: 'Riverside', expectedZip: '92501', expectedPhone: '909-555-0342', expectedEmail: 'zachary.huang.demo@example.com' },
  { id: 'RD-0050', expectedName: 'Beatriz Nascimento', expectedDob: '1956-08-22', expectedCity: 'Colton', expectedZip: '92324', expectedPhone: '909-555-0343', expectedEmail: 'beatriz.nascimento.demo@example.com' },
  { id: 'RD-0051', expectedName: 'Preetam ', expectedDob: '1999-03-03', expectedCity: 'new york ', expectedZip: '652325', expectedPhone: '4564956522', expectedEmail: 'preetamvarma06@gmail.com' },
  { id: 'RD-0054', expectedName: 'Linda M. Cho', expectedDob: '1978-06-30', expectedCity: null, expectedZip: null, expectedPhone: null, expectedEmail: null },
  { id: 'RD-0055', expectedName: 'Test Patient', expectedDob: '1990-01-01', expectedCity: null, expectedZip: null, expectedPhone: null, expectedEmail: null },
  { id: 'RD-0056', expectedName: 'Test Case 1790236145937-4', expectedDob: '1991-02-02', expectedCity: null, expectedZip: null, expectedPhone: null, expectedEmail: null },
  { id: 'RD-0057', expectedName: 'Test Patient', expectedDob: '1990-01-01', expectedCity: null, expectedZip: null, expectedPhone: null, expectedEmail: null },
  { id: 'RD-0058', expectedName: 'Prince yerralagadda', expectedDob: '2004-10-08', expectedCity: 'Visakhapatnam', expectedZip: '530052', expectedPhone: null, expectedEmail: 'prince.y@gmail.com' },
  { id: 'RD-0059', expectedName: 'Insurance Verify Test', expectedDob: '1990-01-01', expectedCity: null, expectedZip: null, expectedPhone: null, expectedEmail: 'insverify@example.com' },
  { id: 'RD-0060', expectedName: 'Delete Route Test', expectedDob: '1993-03-03', expectedCity: null, expectedZip: null, expectedPhone: null, expectedEmail: null },
]

describe('unified patient record migration', () => {
  it('every patient row has a name/dob matching the pre-migration Tebra-preferred value', async () => {
    const db = getDb()
    const ids = PRE_MIGRATION_SNAPSHOT.map((row) => row.id)
    const liveRows = await db
      .select({
        id: patients.id,
        name: patients.name,
        dob: sql<string>`${patients.dob}::text`,
        city: patients.city,
        zip: patients.zip,
        phone: patients.phone,
        email: patients.email,
      })
      .from(patients)
      .where(inArray(patients.id, ids))

    const liveById = new Map(liveRows.map((row) => [row.id, row]))

    // A handful of the snapshotted ids are ephemeral rows other test suites
    // create/delete against this same shared live DB; require most of the
    // 58 to still be present so this test still catches a real regression
    // (e.g. the whole patients table coming back empty) rather than only
    // ever seeing benign churn.
    expect(liveRows.length).toBeGreaterThanOrEqual(50)

    for (const expected of PRE_MIGRATION_SNAPSHOT) {
      const live = liveById.get(expected.id)
      if (!live) continue // deleted by unrelated concurrent test activity
      expect(live.name, `name mismatch for ${expected.id}`).toBe(expected.expectedName)
      expect(live.dob, `dob mismatch for ${expected.id}`).toBe(expected.expectedDob)
      expect(live.city, `city mismatch for ${expected.id}`).toBe(expected.expectedCity)
      expect(live.zip, `zip mismatch for ${expected.id}`).toBe(expected.expectedZip)
      expect(live.phone, `phone mismatch for ${expected.id}`).toBe(expected.expectedPhone)
      expect(live.email, `email mismatch for ${expected.id}`).toBe(expected.expectedEmail)
    }
  })

  it('patients table no longer has the old dual-sourced or cross-system-reference columns', async () => {
    const db = getDb()
    const result = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'patients'
    `)
    const columns = new Set(result.rows.map((r) => r.column_name))

    const removedColumns = [
      'name_tebra', 'name_intakeq',
      'dob_tebra', 'dob_intakeq',
      'city_tebra', 'city_intakeq',
      'zip_tebra', 'zip_intakeq',
      'phone_tebra', 'phone_intakeq',
      'email_tebra', 'email_intakeq',
      'intakeq_client_id_encrypted', 'tebra_patient_id_encrypted', 'tebra_chart_url',
    ]
    for (const column of removedColumns) {
      expect(columns.has(column), `expected ${column} to be dropped from patients`).toBe(false)
    }

    // The single-sourced replacements must exist.
    for (const column of ['name', 'dob', 'city', 'zip', 'phone', 'email']) {
      expect(columns.has(column), `expected ${column} to exist on patients`).toBe(true)
    }
  })

  it('name and dob are NOT NULL on patients; city/zip/phone/email stay nullable', async () => {
    const db = getDb()
    const result = await db.execute<{ column_name: string; is_nullable: string }>(sql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'patients' AND column_name IN ('name', 'dob', 'city', 'zip', 'phone', 'email')
    `)
    const nullability = new Map(result.rows.map((r) => [r.column_name, r.is_nullable]))

    for (const column of ['name', 'dob']) {
      expect(nullability.get(column), `expected ${column} to be NOT NULL`).toBe('NO')
    }
    for (const column of ['city', 'zip', 'phone', 'email']) {
      expect(nullability.get(column), `expected ${column} to remain nullable`).toBe('YES')
    }
  })

  it('diagnoses table no longer has the source column', async () => {
    const db = getDb()
    const result = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'diagnoses'
    `)
    const columns = new Set(result.rows.map((r) => r.column_name))
    expect(columns.has('source')).toBe(false)
  })

  it('app_settings table no longer has the EHR-credential columns', async () => {
    const db = getDb()
    const result = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'app_settings'
    `)
    const columns = new Set(result.rows.map((r) => r.column_name))
    for (const column of [
      'intakeq_api_key_encrypted',
      'tebra_customer_key_encrypted',
      'tebra_user_encrypted',
      'tebra_password_encrypted',
    ]) {
      expect(columns.has(column), `expected ${column} to be dropped from app_settings`).toBe(false)
    }
  })

  it('identity_matches table no longer exists', async () => {
    const db = getDb()
    const result = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables WHERE table_name = 'identity_matches'
    `)
    expect(result.rows.length).toBe(0)
  })

  it('match_status enum type no longer exists', async () => {
    const db = getDb()
    const result = await db.execute<{ typname: string }>(sql`
      SELECT typname FROM pg_type WHERE typname = 'match_status'
    `)
    expect(result.rows.length).toBe(0)
  })
})
