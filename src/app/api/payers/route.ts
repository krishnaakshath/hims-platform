import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { listPayers } from '@/lib/queries/payers'

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const payers = await listPayers()
  return NextResponse.json(payers)
}
