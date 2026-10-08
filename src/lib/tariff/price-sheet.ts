// Wave G P1-05: the price lookup's rate card. Pure: given a service's rate rows and a date,
// list every rate in force that day by scope (base, department, payer) and room category /
// ward, with INR amounts. Carries no PHI. Lookup roles see payer and department NAMES only
// where a rate exists for them (never the payer master itself).
import { formatPaise } from '@/lib/format'
import type { TariffScope } from '@/lib/tariff/resolve'

export interface PriceSheetRate {
  id: number
  scope: TariffScope
  departmentId: number | null
  departmentName: string | null
  payerId: number | null
  payerName: string | null
  roomCategoryCode: string | null
  ward: string | null
  amountPaise: number
  validFrom: string
  validTo: string | null
  deactivatedAt: Date | string | null
}

export interface PriceSheetRow {
  rateId: number
  scope: TariffScope
  departmentId: number | null
  departmentName: string | null
  payerId: number | null
  payerName: string | null
  roomCategoryCode: string | null
  roomCategoryName: string | null
  ward: string | null
  amountPaise: number
  formatted: string
  validFrom: string
  validTo: string | null
}

export interface PriceSheet {
  rows: PriceSheetRow[]
  payers: { id: number; name: string }[]
  departments: { id: number; name: string }[]
  wards: string[]
}

const SCOPE_ORDER: Record<TariffScope, number> = { base: 0, department: 1, payer: 2 }

/** 0 = generic, 1 = room category, 2 = ward, 3 = both (the resolver's specificity order). */
const specificity = (r: PriceSheetRate) => (r.ward ? 2 : 0) + (r.roomCategoryCode ? 1 : 0)

export function buildPriceSheet(
  rates: PriceSheetRate[],
  onDate: string,
  roomCategories: { code: string; name: string }[],
): PriceSheet {
  const catName = new Map(roomCategories.map((c) => [c.code.toUpperCase(), c.name]))
  const inForce = rates.filter((r) => !r.deactivatedAt && r.validFrom <= onDate && (r.validTo === null || onDate <= r.validTo))
  inForce.sort((a, b) =>
    SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]
    || (a.departmentName ?? '').localeCompare(b.departmentName ?? '', 'en-IN')
    || (a.payerName ?? '').localeCompare(b.payerName ?? '', 'en-IN')
    || specificity(a) - specificity(b)
    || (a.roomCategoryCode ?? '').localeCompare(b.roomCategoryCode ?? '', 'en-IN')
    || (a.ward ?? '').localeCompare(b.ward ?? '', 'en-IN')
    || a.id - b.id)

  const rows: PriceSheetRow[] = inForce.map((r) => ({
    rateId: r.id,
    scope: r.scope,
    departmentId: r.departmentId,
    departmentName: r.departmentName,
    payerId: r.payerId,
    payerName: r.payerName,
    roomCategoryCode: r.roomCategoryCode,
    roomCategoryName: r.roomCategoryCode ? catName.get(r.roomCategoryCode.toUpperCase()) ?? r.roomCategoryCode : null,
    ward: r.ward,
    amountPaise: r.amountPaise,
    formatted: formatPaise(r.amountPaise),
    validFrom: r.validFrom,
    validTo: r.validTo,
  }))

  const payers = new Map<number, string>()
  const departments = new Map<number, string>()
  const wards = new Set<string>()
  for (const r of rows) {
    if (r.payerId !== null) payers.set(r.payerId, r.payerName ?? `Payer ${r.payerId}`)
    if (r.departmentId !== null) departments.set(r.departmentId, r.departmentName ?? `Department ${r.departmentId}`)
    if (r.ward) wards.add(r.ward)
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en-IN')
  return {
    rows,
    payers: [...payers].map(([id, name]) => ({ id, name })).sort(byName),
    departments: [...departments].map(([id, name]) => ({ id, name })).sort(byName),
    wards: [...wards].sort((a, b) => a.localeCompare(b, 'en-IN')),
  }
}
