import { hospitalReportPage } from '@/components/reports/hospital-report-page'

// Wave I (P1-23): gate, range, query and audit live in hospitalReportPage (src/lib/reports/catalog.ts roles).
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return hospitalReportPage('ipd', searchParams)
}
