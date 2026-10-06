// Usage: node --env-file=.env.local scripts/apply-sql.mjs <file.sql>
import dns from 'node:dns'
import fs from 'node:fs'
import pg from 'pg'

// IPv6 egress is dead here; see the comment in src/db/client.ts.
dns.setDefaultResultOrder('ipv4first')

const file = process.argv[2]
if (!file) {
  console.error('usage: apply-sql.mjs <file.sql>')
  process.exit(1)
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

try {
  await client.connect()
  await client.query(fs.readFileSync(file, 'utf8'))
  const { rows } = await client.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_name = 'doctor_assignments'
       AND column_name IN ('patient_notified_at','decline_acknowledged_at','decline_acknowledged_by_name')
     ORDER BY column_name`,
  )
  console.table(rows)
} catch (err) {
  console.error(err)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
