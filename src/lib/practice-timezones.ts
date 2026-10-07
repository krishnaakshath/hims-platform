// Hospital time zones the Settings page offers (Wave A, P1-27). India
// Standard Time is the default and the zone every clinical/billing screen
// uses; the others cover South-Asian and Gulf sister sites. No US zones.
export const DEFAULT_PRACTICE_TIMEZONE = 'Asia/Kolkata'

export const PRACTICE_TIMEZONES: readonly { value: string; label: string }[] = [
  { value: 'Asia/Kolkata', label: 'India Standard Time (IST, UTC+05:30) — Asia/Kolkata' },
  { value: 'Asia/Kathmandu', label: 'Nepal Time (UTC+05:45) — Asia/Kathmandu' },
  { value: 'Asia/Dhaka', label: 'Bangladesh Time (UTC+06:00) — Asia/Dhaka' },
  { value: 'Asia/Colombo', label: 'Sri Lanka Time (UTC+05:30) — Asia/Colombo' },
  { value: 'Asia/Thimphu', label: 'Bhutan Time (UTC+06:00) — Asia/Thimphu' },
  { value: 'Indian/Maldives', label: 'Maldives Time (UTC+05:00) — Indian/Maldives' },
  { value: 'Asia/Dubai', label: 'Gulf Standard Time (UTC+04:00) — Asia/Dubai' },
  { value: 'Asia/Singapore', label: 'Singapore Time (UTC+08:00) — Asia/Singapore' },
]

export function isPracticeTimezone(value: string): boolean {
  return PRACTICE_TIMEZONES.some((z) => z.value === value)
}
