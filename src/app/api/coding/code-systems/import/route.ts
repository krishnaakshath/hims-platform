// POST /api/coding/code-systems/import: check (dry run) or load a code-system CSV, all-or-nothing.
//
// - Gate first: requireSession, then CODE_SYSTEM_ADMIN_ROLES, before the body is touched.
// - The body is JSON `{ kind, version, name, licenceNote, sourceFileName, csv, commit, makeCurrent }`,
//   read with a hard byte cap (readCappedBody) and held in memory only. Every oversize case is the
//   same 413 that points the owner at the CLI (`npm run codes:import`, ruling 9).
// - Validation always runs first (src/lib/coding/import.ts; its messages never echo cells). Issues
//   are a 400 with line numbers and nothing is written.
// - A commit is ONE transaction in the query layer, audit row included.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODE_SYSTEM_ADMIN_ROLES } from '@/lib/role-policy'
import { WEB_IMPORT_LIMITS, validateCodeSystemImport } from '@/lib/coding/import'
import { codeSystemImportSchema } from '@/lib/coding/validation'
import { readCappedBody } from '@/lib/http/read-capped-body'
import { isUniqueViolation } from '@/lib/db-errors'
import { codingJson as json, codingServerError } from '@/lib/coding/route-responses'
import {
  CodeSystemVersionExistsError, SampleOverLicensedError, commitCodeSystemImport, sha256Hex,
} from '@/lib/queries/code-systems'

const TOO_LARGE = 'This file is too large for the web importer (4 MB). Load it with npm run codes:import; see docs/CODE-SYSTEMS.md.'
const INVALID = 'Invalid import'
const VERSION_EXISTS = 'That version of this code set is already loaded'
const SAMPLE_OVER_LICENSED = 'A sample code set cannot replace a licensed one'
// JSON string escaping can at most double an ordinary CSV; the CSV itself is then held to
// WEB_IMPORT_LIMITS.maxBytes exactly.
const MAX_BODY_BYTES = 2 * WEB_IMPORT_LIMITS.maxBytes + 4096

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODE_SYSTEM_ADMIN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') return json(415, 'Send the import as application/json')

  const read = await readCappedBody(request, MAX_BODY_BYTES)
  if (!read.ok) return read.reason === 'too_large' ? json(413, TOO_LARGE) : json(400, INVALID)

  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes))
  } catch {
    return json(400, INVALID)
  }
  const parsed = codeSystemImportSchema.safeParse(body)
  if (!parsed.success) return json(400, INVALID)
  const { kind, version, name, licenceNote, sourceFileName, csv, commit, makeCurrent } = parsed.data
  if (csv.length > WEB_IMPORT_LIMITS.maxBytes || new TextEncoder().encode(csv).byteLength > WEB_IMPORT_LIMITS.maxBytes) {
    return json(413, TOO_LARGE)
  }

  const meta = { kind, version, name, licenceNote }
  const result = validateCodeSystemImport(csv, meta, WEB_IMPORT_LIMITS)
  if (result.issues.length > 0) return NextResponse.json({ error: INVALID, issues: result.issues }, { status: 400 })
  if (!commit) return NextResponse.json({ ok: true, codeCount: result.rows.length, isSample: result.isSample })

  try {
    const r = await commitCodeSystemImport(
      { ...meta, sourceFileName, sourceSha256: sha256Hex(csv), makeCurrent, isSample: result.isSample },
      result.rows,
      session,
    )
    return NextResponse.json(r, { status: 201 })
  } catch (err) {
    if (err instanceof CodeSystemVersionExistsError) return json(409, VERSION_EXISTS)
    if (err instanceof SampleOverLicensedError) return json(409, SAMPLE_OVER_LICENSED)
    if (isUniqueViolation(err, 'code_systems_kind_version_unique')) return json(409, VERSION_EXISTS)
    return codingServerError('code-system import', err, 'Could not load the code set; nothing was loaded')
  }
}
