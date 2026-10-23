import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { AUDIT_CSV_HEADER, auditCsvLine } from '@/lib/audit/csv'
import { todayIsoIn } from '@/lib/india-time'
import { AUDIT_EXPORT_MAX_ROWS, activeFilterKeys, auditLogSnapshot, countAuditLog, iterateAuditLog, parseAuditLogQuery } from '@/lib/queries/audit-log'

// WS8 T12 (spec D19): the filtered audit log as a formula-safe CSV, streamed in keyset batches,
// capped at 50,000 rows. The export is itself audited with the filter KEYS and the row count only:
// filter values (names, search text, UHIDs) never go into the audit row.
export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = parseAuditLogQuery(Object.fromEntries(request.nextUrl.searchParams), { allowCursor: false })
  if (!parsed.ok) return NextResponse.json({ error: 'Invalid audit log filters' }, { status: 400 })
  const { filters } = parsed

  const snapshot = await auditLogSnapshot()
  const rows = await countAuditLog(filters, AUDIT_EXPORT_MAX_ROWS, snapshot)
  if (rows > AUDIT_EXPORT_MAX_ROWS) return NextResponse.json({ error: 'Narrow the filters' }, { status: 422 })
  await logAudit(session, 'exported audit log', null, `filters=${activeFilterKeys(filters).join(',') || 'none'} rows=${rows}`)

  // The snapshot keeps the audit row above (and anything written while streaming) out of the file,
  // so the file holds exactly the rows that were counted and audited.
  const source = iterateAuditLog(filters, rows, snapshot)
  const encoder = new TextEncoder()
  let headerSent = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true
        controller.enqueue(encoder.encode(`${AUDIT_CSV_HEADER}\r\n`))
        return
      }
      const chunk: string[] = []
      for (let i = 0; i < 500; i++) {
        const next = await source.next()
        if (next.done) {
          if (chunk.length > 0) controller.enqueue(encoder.encode(chunk.join('')))
          controller.close()
          return
        }
        chunk.push(auditCsvLine(next.value))
      }
      controller.enqueue(encoder.encode(chunk.join('')))
    },
    async cancel() {
      await source.return(undefined)
    },
  })

  const from = filters.from ?? 'all'
  const to = filters.to ?? todayIsoIn()
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-log-${from}-${to}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
