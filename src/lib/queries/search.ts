import { listPatientsWithStatus } from '@/lib/queries/patients'
import { listAllTrials } from '@/lib/queries/trials'
import { listFormTemplates } from '@/lib/queries/form-templates'
import { listServices } from '@/lib/queries/tariff'
import type { SearchScopes } from '@/lib/role-policy'
import { phoneQueryDigits } from '@/lib/patient-directory'

import {
  EMPTY_SEARCH_RESULTS, type SearchResult, type SearchResults, type PatientLookupPage, type PatientLookupResult,
  PATIENT_LOOKUP_MIN_QUERY, PATIENT_LOOKUP_MAX_QUERY, PATIENT_LOOKUP_DEFAULT_PAGE_SIZE, PATIENT_LOOKUP_MAX_PAGE_SIZE, PATIENT_LOOKUP_MAX_PAGE,
} from '@/lib/queries/search-types'
import { asc, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { ageOnDate, todayIsoIn } from '@/lib/india-time'

export { EMPTY_SEARCH_RESULTS, type SearchResult, type SearchResults, type PatientLookupPage, type PatientLookupResult, PATIENT_LOOKUP_MAX_PAGE_SIZE }

const MAX_RESULTS_PER_CATEGORY = 8
// The global search bar in TopBanner -- one query fanned out across every
// entity a staff member might be looking for by name. Patients, trials and
// form templates run against each entity's own already-cached list query and
// filter in memory (this app's data scale doesn't warrant search
// infrastructure); services use the tariff catalogue's own `q` filter.
//
// `scopes` limits which lists are even loaded: a category the caller may not
// open is never read and comes back as []. Patient items carry only name, id
// and UHID (no clinical fields, and the phone is matched but never echoed).
export async function searchAll(rawQuery: string, scopes: SearchScopes): Promise<SearchResults> {
  const q = rawQuery.trim().toLowerCase()
  if (q.length === 0) return EMPTY_SEARCH_RESULTS

  const [allPatients, allTrials, allFormTemplates, services] = await Promise.all([
    scopes.patients ? listPatientsWithStatus(null) : Promise.resolve([]),
    scopes.trials ? listAllTrials() : Promise.resolve([]),
    scopes.formTemplates ? listFormTemplates() : Promise.resolve([]),
    scopes.services ? listServices({ q: rawQuery.trim().slice(0, 100), limit: MAX_RESULTS_PER_CATEGORY }) : Promise.resolve([]),
  ])

  const qPhone = phoneQueryDigits(q)
  // listPatientsWithStatus is a patient x screening join (one row per
  // screening), so keep only each patient's first row.
  const seenPatientIds = new Set<string>()
  const patients: SearchResult[] = allPatients
    .filter((p) => {
      if (seenPatientIds.has(p.id)) return false
      seenPatientIds.add(p.id)
      const name = p.name.toLowerCase()
      if (name.includes(q) || p.id.toLowerCase().includes(q) || (p.uhid?.toLowerCase().startsWith(q) ?? false)) return true
      return qPhone !== null && p.phone !== null && p.phone !== undefined && p.phone.replace(/\D/g, '').includes(qPhone)
    })
    .slice(0, MAX_RESULTS_PER_CATEGORY)
    .map((p) => ({ id: p.id, label: p.name, detail: p.uhid ? `${p.id} · ${p.uhid}` : p.id, href: `/patients/${p.id}` }))

  const trials: SearchResult[] = allTrials
    .filter((t) => t.name.toLowerCase().includes(q) || t.condition.toLowerCase().includes(q) || t.nctNumber.toLowerCase().includes(q))
    .slice(0, MAX_RESULTS_PER_CATEGORY)
    .map((t) => ({ id: t.id, label: t.name, detail: t.condition, href: `/trials/${t.id}` }))

  const formTemplates: SearchResult[] = allFormTemplates
    .filter((f) => f.name.toLowerCase().includes(q) || f.category.toLowerCase().includes(q))
    .slice(0, MAX_RESULTS_PER_CATEGORY)
    .map((f) => ({ id: String(f.id), label: f.name, detail: f.category, href: `/forms/${f.id}` }))

  const serviceResults: SearchResult[] = services
    .slice(0, MAX_RESULTS_PER_CATEGORY)
    .map((s) => ({ id: String(s.id), label: s.name, detail: s.departmentName ? `${s.code} · ${s.departmentName}` : s.code, href: `/tariffs/services/${s.id}` }))

  return { patients, trials, formTemplates, services: serviceResults }
}

// ---- Wave C P0-04: patient picker lookup ---------------------------------
// One SQL query (not the cached full list) so the picker stays cheap at any
// directory size. Matches name (substring), UHID (prefix, so the exact UHID
// too), anonymous chart id (prefix) -- all case-insensitive -- and mobile
// (national digits: the last 10 digits when a full number is typed, else a
// digit substring of at least 5). Exact UHID / chart id / mobile hits rank
// first, then name-prefix hits, then the rest, by name.


/** Escape LIKE metacharacters so a query is matched literally (default escape char is backslash). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

const clamp = (n: number | undefined, lo: number, hi: number, dflt: number) =>
  Number.isInteger(n) ? Math.min(Math.max(n as number, lo), hi) : dflt

export async function lookupPatients(
  rawQuery: string,
  opts: { includePhone: boolean; page?: number; pageSize?: number },
): Promise<PatientLookupPage> {
  const pageSize = clamp(opts.pageSize, 1, PATIENT_LOOKUP_MAX_PAGE_SIZE, PATIENT_LOOKUP_DEFAULT_PAGE_SIZE)
  const page = clamp(opts.page, 1, PATIENT_LOOKUP_MAX_PAGE, 1)
  const term = rawQuery.trim().slice(0, PATIENT_LOOKUP_MAX_QUERY)
  if (term.length < PATIENT_LOOKUP_MIN_QUERY) return { results: [], page, pageSize, hasMore: false }

  const upper = term.toUpperCase()
  const esc = escapeLike(term)
  const escUpper = escapeLike(upper)
  const phoneDigits = sql`regexp_replace(coalesce(${patients.phone}, ''), '[^0-9]', '', 'g')`
  const digits = phoneQueryDigits(term)
  const last10 = digits !== null && digits.length >= 10 ? digits.slice(-10) : null

  const matches: SQL[] = [
    sql`${patients.name} ilike ${`%${esc}%`}`,
    sql`upper(${patients.uhid}) like ${`${escUpper}%`}`,
    sql`upper(${patients.id}) like ${`${escUpper}%`}`,
  ]
  if (last10 !== null) matches.push(sql`right(${phoneDigits}, 10) = ${last10}`)
  else if (digits !== null) matches.push(sql`${phoneDigits} like ${`%${digits}%`}`)

  const exact: SQL[] = [sql`upper(${patients.uhid}) = ${upper}`, sql`upper(${patients.id}) = ${upper}`]
  if (last10 !== null) exact.push(sql`right(${phoneDigits}, 10) = ${last10}`)
  const rank = sql<number>`case when ${or(...exact)} then 0 when ${patients.name} ilike ${`${esc}%`} then 1 else 2 end`

  const rows = await getDb()
    .select({ id: patients.id, name: patients.name, uhid: patients.uhid, gender: patients.gender, dob: patients.dob, phone: patients.phone })
    .from(patients)
    .where(or(...matches))
    .orderBy(rank, asc(patients.name), asc(patients.id))
    .limit(pageSize + 1)
    .offset((page - 1) * pageSize)

  const today = todayIsoIn()
  const results: PatientLookupResult[] = rows.slice(0, pageSize).map((r) => ({
    id: r.id,
    name: r.name,
    uhid: r.uhid ?? null,
    gender: r.gender ?? null,
    ageYears: r.dob ? ageOnDate(String(r.dob), today) : null,
    ...(opts.includePhone ? { phone: r.phone ?? null } : {}),
  }))
  return { results, page, pageSize, hasMore: rows.length > pageSize }
}
