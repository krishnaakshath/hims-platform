// WS6 T7: a booking form never opens on a past date. A requested range that has already started
// (or wholly passed) opens on today; a future range opens on its first day. YYYY-MM-DD strings
// compare correctly as text; the range end never moves the default.
export function defaultBookingDate(rangeStart: string, rangeEnd: string, todayIso: string): string {
  return rangeStart >= todayIso ? rangeStart : todayIso
}
