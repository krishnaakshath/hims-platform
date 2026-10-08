// Compares the public-schema catalogue of two databases: columns, constraints,
// indexes, triggers, enums, functions and extensions. Use it to prove that a
// database built by `db:migrate` from empty equals one that has been running
// for a while (or a dev database built by drizzle-kit push).
//
//   npx dotenv -e .env.local -- tsx scripts/db/schema-diff.ts hims hims_fresh
//
// Bare names are database names on the DATABASE_URL server; full
// postgres:// URLs work too. Prints only catalogue entries, never data.
// Exit 0 = identical, 1 = differences.
import dns from 'node:dns'
import pg from 'pg'
import { LEDGER_TABLE } from '../../src/db/migrations'
import { describeDatabaseUrl, sslFor } from '../../src/db/url'

dns.setDefaultResultOrder('ipv4first')

const QUERIES: Record<string, string> = {
  column: `SELECT table_name || '.' || column_name || ' ' || udt_name || CASE WHEN is_nullable = 'NO' THEN ' not null' ELSE '' END
             || COALESCE(' default ' || column_default, '') AS k
           FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '${LEDGER_TABLE}'`,
  constraint: `SELECT cl.relname || ': ' || co.conname || ' ' || pg_get_constraintdef(co.oid) AS k
           FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
           WHERE n.nspname = 'public' AND cl.relname <> '${LEDGER_TABLE}'`,
  index: `SELECT indexdef AS k FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '${LEDGER_TABLE}'`,
  trigger: `SELECT pg_get_triggerdef(t.oid) AS k FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
  enum: `SELECT t.typname || ' = ' || string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS k
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public' GROUP BY t.typname`,
  function: `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') md5:' || md5(p.prosrc) AS k
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`,
  extension: `SELECT extname AS k FROM pg_extension`,
}

export type Snapshot = Record<string, Set<string>>

export async function snapshot(connectionString: string): Promise<Snapshot> {
  const c = new pg.Client({ connectionString, ssl: sslFor(connectionString) })
  await c.connect()
  try {
    const out: Snapshot = {}
    for (const [kind, sql] of Object.entries(QUERIES)) {
      const r = await c.query(sql)
      out[kind] = new Set(r.rows.map((row) => row.k as string))
    }
    return out
  } finally {
    await c.end()
  }
}

export function diffSnapshots(a: Snapshot, b: Snapshot): { kind: string; onlyA: string[]; onlyB: string[] }[] {
  return Object.keys(QUERIES).map((kind) => ({
    kind,
    onlyA: [...a[kind]].filter((k) => !b[kind].has(k)).sort(),
    onlyB: [...b[kind]].filter((k) => !a[kind].has(k)).sort(),
  }))
}

function resolve(arg: string): string {
  if (/^postgres(ql)?:\/\//.test(arg)) return arg
  const u = new URL(process.env.DATABASE_URL ?? '')
  u.pathname = `/${arg}`
  return u.toString()
}

async function main() {
  const [a, b] = process.argv.slice(2)
  if (!a || !b) {
    console.error('usage: schema-diff.ts <db-or-url-A> <db-or-url-B>')
    return 64
  }
  const [ua, ub] = [resolve(a), resolve(b)]
  const [sa, sb] = await Promise.all([snapshot(ua), snapshot(ub)])
  console.log(`A = ${describeDatabaseUrl(ua)}\nB = ${describeDatabaseUrl(ub)}`)
  let differences = 0
  for (const d of diffSnapshots(sa, sb)) {
    console.log(`${d.kind}: A ${sa[d.kind].size}, B ${sb[d.kind].size}`)
    for (const k of d.onlyA) console.log(`  only in A: ${k}`)
    for (const k of d.onlyB) console.log(`  only in B: ${k}`)
    differences += d.onlyA.length + d.onlyB.length
  }
  console.log(differences === 0 ? 'identical' : `${differences} difference(s)`)
  return differences === 0 ? 0 : 1
}

main().then((code) => process.exit(code), (e) => {
  console.error(`schema-diff failed: ${(e as Error).name} ${(e as NodeJS.ErrnoException).code ?? ''}`)
  process.exit(2)
})
