import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactElement } from 'react'

let role: string = 'billing'
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'T', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patient-collections', () => ({ listPatientCollections: vi.fn(async () => []) }))
vi.mock('@/lib/queries/patient-statements', () => ({ listPatientStatements: vi.fn(async () => []) }))
vi.mock('@/lib/queries/insurance-claims', () => ({ listInsuranceClaims: vi.fn(async () => []) }))
vi.mock('@/components/PatientCollectionsTable', () => ({ PatientCollectionsTable: () => null }))
vi.mock('@/components/PatientStatementsTable', () => ({ PatientStatementsTable: () => null }))
vi.mock('@/components/InsuranceClaimsTable', () => ({ InsuranceClaimsTable: () => null }))

import PatientCollectionsPage from '@/app/(dashboard)/billing/patient-collections/page'
import PatientStatementsPage from '@/app/(dashboard)/billing/statements/page'
import InsuranceCollectionsPage from '@/app/(dashboard)/billing/insurance-collections/page'

// Walk the returned element tree and find the table element's props.
function findProps(node: unknown, name: string): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null
  const el = node as ReactElement<{ children?: unknown }>
  if (typeof el.type === 'function' && el.type.name === name) return el.props as Record<string, unknown>
  const kids = el.props?.children
  for (const k of Array.isArray(kids) ? kids : [kids]) {
    const hit = findProps(k, name)
    if (hit) return hit
  }
  return null
}

const pages = [
  { name: 'PatientCollectionsTable', page: PatientCollectionsPage },
  { name: 'PatientStatementsTable', page: PatientStatementsPage },
  { name: 'InsuranceClaimsTable', page: InsuranceCollectionsPage },
]

describe.each(pages)('$name page', ({ name, page }) => {
  beforeEach(() => { role = 'billing' })

  it.each([['billing', false], ['crc', true], ['admin', true]] as const)('%s gets linkPatients=%s', async (r, expected) => {
    role = r
    const props = findProps(await page(), name)
    expect(props).not.toBeNull()
    expect(props!.linkPatients).toBe(expected)
  })
})
