'use client'
import { ErrorFallback } from '@/components/ErrorFallback'

// Patient-portal error boundary: home is the portal, not the staff dashboard.
export default function RouteError({ error, retry }: { error: Error & { digest?: string }; retry: () => void; reset?: () => void }) {
  return <ErrorFallback digest={error.digest} retry={retry} homeHref="/patient-portal" homeLabel="Go to home" />
}
