'use client'
import { ErrorFallback } from '@/components/ErrorFallback'

// Route error boundary: fixed text, a retry, a way home. Never renders
// error.message (see ErrorFallback).
export default function RouteError({ error, retry }: { error: Error & { digest?: string }; retry: () => void; reset?: () => void }) {
  return <ErrorFallback digest={error.digest} retry={retry} homeHref="/" homeLabel="Go to dashboard" />
}
