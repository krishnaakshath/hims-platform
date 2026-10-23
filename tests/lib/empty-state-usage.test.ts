import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// WS7 T16 (spec D22): list pages use the shared EmptyState instead of a bare "No … yet" paragraph.
// Each entry is the page module and the client component that renders its empty list.
const ROOT = join(__dirname, '..', '..', 'src')
const PAGES: { page: string; renders: string }[] = [
  { page: 'app/(dashboard)/front-desk/follow-ups/page.tsx', renders: 'components/follow-ups/FollowUpWorklist.tsx' },
  { page: 'app/(dashboard)/booking-requests/page.tsx', renders: 'components/BookingRequestsQueue.tsx' },
  { page: 'app/(dashboard)/home-collections/page.tsx', renders: 'components/home-collection/HomeCollectionBoard.tsx' },
  { page: 'app/(dashboard)/pharmacy/billing/page.tsx', renders: 'app/(dashboard)/pharmacy/billing/page.tsx' },
  { page: 'app/(dashboard)/forms/page.tsx', renders: 'app/(dashboard)/forms/page.tsx' },
  { page: 'app/(dashboard)/documents/page.tsx', renders: 'components/DocumentsReportTable.tsx' },
  { page: 'app/(dashboard)/broadcasts/page.tsx', renders: 'app/(dashboard)/broadcasts/page.tsx' },
  { page: 'app/(dashboard)/rcm/payers/page.tsx', renders: 'app/(dashboard)/rcm/payers/page.tsx' },
  { page: 'app/(dashboard)/staff/page.tsx', renders: 'components/StaffDirectoryList.tsx' },
]
const BARE_EMPTY = /<p[^>]*>\s*No [^<]* yet/
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

describe('EmptyState usage on list pages', () => {
  it.each(PAGES)('$page uses EmptyState and has no bare "No … yet" paragraph', ({ page, renders }) => {
    const pageSrc = read(page)
    const renderedSrc = read(renders)
    expect(pageSrc.includes(renders.split('/').pop()!.replace('.tsx', '')) || page === renders).toBe(true)
    expect(renderedSrc).toMatch(/import \{[^}]*\bEmptyState\b[^}]*\} from '@\/components\/ui\/empty-state'/)
    expect(pageSrc).not.toMatch(BARE_EMPTY)
    expect(renderedSrc).not.toMatch(BARE_EMPTY)
  })
})
