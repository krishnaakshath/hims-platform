// Client-safe: imports TYPES ONLY from @/db/schema (no drizzle at runtime). Scopes and
// categories are re-declared here and tied to the schema by tests/lib/tariff/validation.test.ts.
import { z } from 'zod'
import type { serviceCategoryEnum } from '@/db/schema'

export type ServiceCategory = (typeof serviceCategoryEnum.enumValues)[number]

export const RATE_SCOPES = ['base', 'department', 'payer'] as const
export const SERVICE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,23}$/
export const ROOM_CATEGORY_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,15}$/

export const SERVICE_CATEGORIES: readonly { code: ServiceCategory; label: string }[] = [
  { code: 'consultation', label: 'Consultation' },
  { code: 'procedure', label: 'Procedure' },
  { code: 'investigation_lab', label: 'Investigation (lab)' },
  { code: 'investigation_imaging', label: 'Investigation (imaging)' },
  { code: 'room_rent', label: 'Room rent' },
  { code: 'nursing', label: 'Nursing' },
  { code: 'pharmacy', label: 'Pharmacy' },
  { code: 'consumable', label: 'Consumable' },
  { code: 'package', label: 'Package' },
  { code: 'other', label: 'Other' },
]
const CATEGORY_CODES = SERVICE_CATEGORIES.map((c) => c.code) as [ServiceCategory, ...ServiceCategory[]]

// Package integrity: a package's items are never packages, so a category change may not break that.
export const PACKAGE_HAS_ITEMS_MESSAGE = 'This package still has items; remove them before changing its category'
export const IS_PACKAGE_ITEM_MESSAGE = 'This service is an item of a package; remove it from that package before making it a package'
export const PACKAGE_CHANGED_MESSAGE = 'The package or one of its items changed category; reload and try again'

export const GOODS_CATEGORIES = ['pharmacy', 'consumable'] as const

// Pre-September-2025 slabs are kept because tariffs are effective-dated.
export const GST_RATES_BP = [0, 500, 1200, 1800, 2800, 4000] as const

/** '18', '18%', '18.0' -> 1800. Null unless the value is one of GST_RATES_BP. */
export function gstPercentToBp(input: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/.exec(input.trim())
  if (!m) return null
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
  return (GST_RATES_BP as readonly number[]).includes(bp) ? bp : null
}

/** SAC: exactly 6 digits starting 99. HSN: 4, 6 or 8 digits that are not a SAC (so '9993' is an HSN). */
export function hsnSacKind(code: string): 'sac' | 'hsn' | null {
  if (/^99\d{4}$/.test(code)) return 'sac'
  if (/^\d{4}$|^\d{6}$|^\d{8}$/.test(code) && !/^99\d{4}$/.test(code)) return 'hsn'
  return null
}

export function hsnSacProblem(category: ServiceCategory, code: string): string | null {
  const kind = hsnSacKind(code)
  if (kind === null) return 'HSN/SAC must be a 4, 6 or 8 digit HSN, or a 6 digit SAC starting 99'
  if (category === 'other') return null
  const goods = (GOODS_CATEGORIES as readonly string[]).includes(category)
  if (goods && kind !== 'hsn') return 'Goods (pharmacy, consumable) need an HSN code, not a SAC'
  if (!goods && kind !== 'sac') return 'Services need a SAC code (6 digits starting 99)'
  return null
}

/** YYYY-MM-DD that round-trips through Date.UTC (rejects 2026-02-30). */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').refine((s) => {
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}, 'Not a real calendar date')

const positiveInt = z.number().int().positive()

/** tariff_rates.amount_paise is int4: amounts are capped at ₹1 crore (1_000_000_000 paise). */
export const MAX_AMOUNT_PAISE = 1_000_000_000
export const AMOUNT_CAP_MESSAGE = 'Amount cannot exceed ₹1,00,00,000'
// A refinement (code 'custom') so the routes pass the fixed message on rather than a generic one.
const amountPaise = z.number().int().min(0).refine((v) => v <= MAX_AMOUNT_PAISE, AMOUNT_CAP_MESSAGE)

const serviceBase = z.object({
  code: z.string().trim().toUpperCase().regex(SERVICE_CODE_PATTERN, 'Code must be 2-24 chars: A-Z, 0-9, . _ -'),
  name: z.string().trim().min(1).max(200),
  departmentId: positiveInt,
  category: z.enum(CATEGORY_CODES),
  hsnSac: z.string().trim(),
  gstRateBp: z.number().refine((v) => (GST_RATES_BP as readonly number[]).includes(v), 'GST rate must be 0, 5, 12, 18, 28 or 40%'),
  // SP4 billing flags.
  requiresPreauth: z.boolean().optional(),
  maxQuantity: z.number().int().min(1).max(1000).nullable().optional(),
}).strict()

export const serviceCreateSchema = serviceBase.superRefine((v, ctx) => {
  const problem = hsnSacProblem(v.category, v.hsnSac)
  if (problem) ctx.addIssue({ code: 'custom', path: ['hsnSac'], message: problem })
})

export const serviceUpdateSchema = serviceBase.omit({ code: true }).partial().extend({ isActive: z.boolean().optional() }).strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
  .superRefine((v, ctx) => {
    if (v.category !== undefined && v.hsnSac !== undefined) {
      const problem = hsnSacProblem(v.category, v.hsnSac)
      if (problem) ctx.addIssue({ code: 'custom', path: ['hsnSac'], message: problem })
    }
  })

export const rateCreateSchema = z.object({
  serviceId: positiveInt,
  scope: z.enum(RATE_SCOPES),
  departmentId: positiveInt.optional(),
  payerId: positiveInt.optional(),
  roomCategoryId: positiveInt.optional(),
  ward: z.string().trim().min(1).max(60).optional(),
  amountPaise,
  validFrom: isoDate,
  validTo: isoDate.optional(),
}).strict().superRefine((v, ctx) => {
  // mirrors tariff_rates_scope_keys
  const dept = v.departmentId !== undefined
  const payer = v.payerId !== undefined
  const ok = v.scope === 'base' ? !dept && !payer
    : v.scope === 'department' ? dept && !payer
    : payer && !dept
  if (!ok) ctx.addIssue({ code: 'custom', path: ['scope'], message: `Scope "${v.scope}" has the wrong department/payer keys` })
  if (v.validTo !== undefined && v.validTo < v.validFrom) {
    ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'Valid-to cannot be before valid-from' })
  }
})

export const rateRevisionSchema = z.object({
  amountPaise,
  effectiveFrom: isoDate,
}).strict()

export const ratePatchSchema = z.union([
  z.object({ validTo: isoDate }).strict(),
  z.object({ deactivate: z.literal(true) }).strict(),
])

const roomCategoryCode = z.string().trim().toUpperCase().regex(ROOM_CATEGORY_CODE_PATTERN, 'Code must be 2-16 chars: A-Z, 0-9, _ and start with a letter')
export const roomCategoryCreateSchema = z.object({ code: roomCategoryCode, name: z.string().trim().min(1).max(100) }).strict()
export const roomCategoryUpdateSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), isActive: z.boolean().optional() }).strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
export const roomAssignmentSchema = z.object({ roomCategoryId: positiveInt.nullable() }).strict()

export const packageItemsSchema = z.object({
  items: z.array(z.object({ serviceId: positiveInt, quantity: z.number().int().min(1).max(999) }).strict()).max(100),
}).strict().superRefine((v, ctx) => {
  const seen = new Set<number>()
  v.items.forEach((it, i) => {
    if (seen.has(it.serviceId)) ctx.addIssue({ code: 'custom', path: ['items', i, 'serviceId'], message: 'Duplicate service in package' })
    seen.add(it.serviceId)
  })
})

// Fields arrive from URLSearchParams as strings.
const queryInt = z.coerce.number().int().positive()
export const resolveQuerySchema = z.object({
  serviceId: queryInt.optional(),
  serviceCode: z.string().trim().min(1).max(40).optional(),
  payerId: queryInt.optional(),
  departmentId: queryInt.optional(),
  roomCategory: z.string().trim().min(1).max(40).optional(),
  ward: z.string().trim().min(1).max(60).optional(),
  onDate: isoDate.optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.serviceId === undefined) === (v.serviceCode === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['serviceId'], message: 'Provide exactly one of serviceId and serviceCode' })
  }
})

export type ServiceCreateInput = z.infer<typeof serviceCreateSchema>
export type ServiceUpdateInput = z.infer<typeof serviceUpdateSchema>
export type RateCreateInput = z.infer<typeof rateCreateSchema>
export type RateRevisionInput = z.infer<typeof rateRevisionSchema>
export type RatePatchInput = z.infer<typeof ratePatchSchema>
export type PackageItemsInput = z.infer<typeof packageItemsSchema>
export type ResolveQueryInput = z.infer<typeof resolveQuerySchema>
