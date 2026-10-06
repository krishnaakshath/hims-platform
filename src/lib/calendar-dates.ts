export type CalendarView = 'day' | 'week' | 'month'

export function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

export function endOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(23, 59, 59, 999)
  return d
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

// Sunday-start week, matching the standard Day/Week/Month calendar convention.
export function startOfWeek(date: Date): Date {
  const d = startOfDay(date)
  d.setDate(d.getDate() - d.getDay())
  return d
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function parseDateParam(param: string | undefined): Date {
  if (!param) return startOfDay(new Date())
  const parsed = new Date(`${param}T00:00:00`)
  return isNaN(parsed.getTime()) ? startOfDay(new Date()) : parsed
}

export function formatDateParam(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function getWeekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor)
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

// A fixed 6-week (42-day) grid, matching the standard month-calendar layout —
// includes the leading/trailing days from adjacent months so those days'
// appointments (if any) still render, grayed out, at the grid's edges.
export function getMonthGridDays(anchor: Date): Date[] {
  const gridStart = startOfWeek(startOfMonth(anchor))
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
}

export function getViewRange(view: CalendarView, anchor: Date): { start: Date; end: Date } {
  if (view === 'day') return { start: startOfDay(anchor), end: endOfDay(anchor) }
  if (view === 'week') {
    const start = startOfWeek(anchor)
    return { start, end: endOfDay(addDays(start, 6)) }
  }
  const gridStart = startOfWeek(startOfMonth(anchor))
  return { start: gridStart, end: endOfDay(addDays(gridStart, 41)) }
}
