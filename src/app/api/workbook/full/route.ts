import { NextResponse } from 'next/server'
import { buildFullWorkbookXlsx } from '@/lib/excel-export'
import { logAudit } from '@/lib/audit'
import { requireSession } from '@/lib/auth'
import { WORKBOOK_EXPORT_ROLES } from '@/lib/role-policy'
import { listWorkbookRows } from '@/lib/queries/workbook'

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  // The complete 30-column pre-screening workbook for every patient: admin
  // and crc only (WORKBOOK_EXPORT_ROLES). Narrower than the /workbook page,
  // which pi may view but which hides the download link from pi.
  if (!WORKBOOK_EXPORT_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const rows = await listWorkbookRows()
  const buffer = await buildFullWorkbookXlsx(rows)
  await logAudit(session, 'exported full 29-column pre-screening workbook', null)

  // See buildWorkbookXlsx's comment in src/lib/excel-export.ts for why this
  // is wrapped in a plain Uint8Array rather than passed as a Node Buffer.
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="ipmg-pre-screening-workbook-full.xlsx"',
    },
  })
}
