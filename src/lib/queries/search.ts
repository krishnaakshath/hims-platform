import { listPatientsWithStatus } from '@/lib/queries/patients'
import { listAllTrials } from '@/lib/queries/trials'
import { listFormTemplates } from '@/lib/queries/form-templates'
import { listServices } from '@/lib/queries/tariff'
import type { SearchScopes } from '@/lib/role-policy'
import { phoneQueryDigits } from '@/lib/patient-directory'

import { EMPTY_SEARCH_RESULTS, type SearchResult, type SearchResults } from '@/lib/queries/search-types'

export { EMPTY_SEARCH_RESULTS, type SearchResult, type SearchResults }

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
