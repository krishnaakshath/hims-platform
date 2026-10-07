import { formatIstDateTime } from '@/lib/india-time'

/**
 * Renders a timestamp in hospital time (Asia/Kolkata) with an "IST" label.
 * The formatter is pure arithmetic (no Intl/toLocale*), so the server HTML and
 * the client render are byte-identical and hydration always agrees.
 */
export function LocalDateTime({ iso, className }: { iso: string; className?: string }) {
  return <time dateTime={iso} className={className}>{formatIstDateTime(iso, { label: true })}</time>
}
