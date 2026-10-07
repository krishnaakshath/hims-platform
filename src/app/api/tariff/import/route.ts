// POST /api/tariff/import: validate (dry run) or commit a services/rates CSV, all-or-nothing.
//
// - Gate first: requireSession, then TARIFF_MANAGE_ROLES, before the body is touched.
// - The body is JSON `{ kind, csv, commit }`. It is read as a stream with a hard byte cap
//   (readCappedBody: declared content-length checked first, bytes counted while reading), held
//   in memory only, and never written to disk.
// - Validation always runs first. Issue messages come from src/lib/tariff/import.ts, which never
//   echoes more than 40 characters of a cell.
// - A commit is ONE transaction in the query layer, with the audit row written inside it.
// - Cell text is stored as data, verbatim. A cell may look like a spreadsheet formula
//   (`=…`, `+…`, `-…`, `@…`); any future CSV/XLSX export of tariff data must escape it.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { TariffPackageIntegrityError, commitRateImport, commitServiceImport, getImportLookups } from '@/lib/queries/tariff'
import { MAX_IMPORT_BYTES, validateRateImport, validateServiceImport } from '@/lib/tariff/import'
import { isExclusionViolation, isUniqueViolation, pgErrorCode } from '@/lib/db-errors'
import { badRequest, conflict, forbidden, serverError } from '@/lib/tariff/route-responses'
import { readCappedBody } from '@/lib/http/read-capped-body'

const TOO_LARGE = 'CSV is larger than 1 MB'
const INVALID = 'Invalid import'
const CONFLICT = 'Import conflicts with existing data; nothing was applied'
// JSON string escaping (\" and \n) can at most double an ordinary CSV; the CSV itself is then
// held to MAX_IMPORT_BYTES exactly. Anything bigger cannot carry a valid CSV.
const MAX_BODY_BYTES = 2 * MAX_IMPORT_BYTES + 4096

const importBodySchema = z.object({
  kind: z.enum(['services', 'rates']),
  csv: z.string(),
  commit: z.boolean(),
}).strict()

const tooLarge = () => NextResponse.json({ error: TOO_LARGE }, { status: 413 })

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) return forbidden()

  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return NextResponse.json({ error: 'Send the import as application/json' }, { status: 415 })
  }
  const read = await readCappedBody(request, MAX_BODY_BYTES)
  if (!read.ok) return read.reason === 'too_large' ? tooLarge() : badRequest(INVALID)
  const bytes = read.bytes

  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return badRequest(INVALID)
  }
  const parsed = importBodySchema.safeParse(body)
  if (!parsed.success) return badRequest(INVALID)
  const { kind, csv, commit } = parsed.data
  // Same 413 as the transport cap above, so every oversize case looks the same to the client.
  if (csv.length > MAX_IMPORT_BYTES || new TextEncoder().encode(csv).byteLength > MAX_IMPORT_BYTES) return tooLarge()

  let lookups
  try {
    lookups = await getImportLookups()
  } catch (err) {
    return serverError('import lookups', err, 'Could not validate the file')
  }
  const services = kind === 'services' ? validateServiceImport(csv, lookups) : null
  const rates = kind === 'rates' ? validateRateImport(csv, lookups) : null
  const result = (services ?? rates)!
  const report = { kind, rowCount: result.rows.length, issues: result.issues }

  if (!commit) return NextResponse.json({ ...report, committed: false })
  if (result.issues.length > 0) return NextResponse.json({ ...report, committed: false }, { status: 422 })
  if (result.rows.length === 0) return badRequest('The file has no rows to import')

  // Every row is applied or none is, so the count is known before the transaction commits.
  const audit = { session, action: `tariff: imported ${result.rows.length} ${kind}` }
  try {
    const applied = services
      ? await commitServiceImport(services.rows, audit)
      : await commitRateImport(rates!.rows, session.name, audit)
    return NextResponse.json({ ...report, committed: true, applied })
  } catch (err) {
    if (err instanceof TariffPackageIntegrityError) return conflict(err.message)
    // Data that changed between validation and commit (a concurrent import or edit).
    if (isExclusionViolation(err) || isUniqueViolation(err) || pgErrorCode(err) === '23503') return conflict(CONFLICT)
    return serverError('import commit', err, 'Could not import the file; nothing was applied')
  }
}
