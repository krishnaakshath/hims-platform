import Link from 'next/link'
import { formatDateParam, getMonthGridDays, isSameDay } from '@/lib/calendar-dates'

export function MiniCalendar({ anchor, providerIdsParam }: { anchor: Date; providerIdsParam: string | undefined }) {
  const days = getMonthGridDays(anchor)
  const monthLabel = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const currentMonth = anchor.getMonth()
  const today = new Date()

  function hrefFor(day: Date): string {
    const params = new URLSearchParams()
    params.set('view', 'day')
    params.set('date', formatDateParam(day))
    if (providerIdsParam !== undefined) params.set('providerIds', providerIdsParam)
    return `/calendar?${params.toString()}`
  }

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{monthLabel}</p>
      <div className="grid grid-cols-7 gap-1 text-center text-xs">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <span key={i} className="text-muted-foreground">{d}</span>
        ))}
        {days.map((day) => {
          const inMonth = day.getMonth() === currentMonth
          const isToday = isSameDay(day, today)
          const isSelected = isSameDay(day, anchor)
          const stateClassName = isSelected
            ? 'bg-primary text-primary-foreground'
            : isToday
              ? 'bg-accent/20 text-foreground'
              : inMonth
                ? 'text-foreground hover:bg-secondary'
                : 'text-muted-foreground/50 hover:bg-secondary'
          return (
            <Link key={day.toISOString()} href={hrefFor(day)} className={`rounded-full py-1 transition-colors ${stateClassName}`}>
              {day.getDate()}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
