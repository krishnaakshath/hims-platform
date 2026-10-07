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
