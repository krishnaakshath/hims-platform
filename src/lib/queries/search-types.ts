// Client-safe search result types (GlobalSearch imports these; search.ts holds the DB code).
export interface SearchResult {
  id: string
  label: string
  detail: string
  href: string
}

export interface SearchResults {
  patients: SearchResult[]
  trials: SearchResult[]
  formTemplates: SearchResult[]
  services: SearchResult[]
}

export const EMPTY_SEARCH_RESULTS: SearchResults = { patients: [], trials: [], formTemplates: [], services: [] }

// Wave C P0-04: one row of the patient picker (/api/patients/lookup). An
// explicit minimal projection: never clinical fields, never Aadhaar/ABHA.
// `phone` is present only for roles that may see a patient's mobile.
export interface PatientLookupResult {
  id: string
  name: string
  uhid: string | null
  gender: string | null
  ageYears: number | null
  phone?: string | null
}

export interface PatientLookupPage {
  results: PatientLookupResult[]
  page: number
  pageSize: number
  hasMore: boolean
}

export const PATIENT_LOOKUP_MIN_QUERY = 2
export const PATIENT_LOOKUP_MAX_QUERY = 100
export const PATIENT_LOOKUP_DEFAULT_PAGE_SIZE = 10
export const PATIENT_LOOKUP_MAX_PAGE_SIZE = 20
export const PATIENT_LOOKUP_MAX_PAGE = 50
