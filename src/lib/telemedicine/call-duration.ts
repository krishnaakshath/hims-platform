// WS7 T6: how long a video visit lasted, for the provider's end-of-call summary
// ("Call lasted 12 min") and the running in-call clock.

const MINUTE_MS = 60_000

/**
 * Whole minutes between the provider joining and the call ending:
 * "under a minute", "12 min", "1 h 05 min". A call that never started
 * (`startedAt` null) or a skewed clock reads as "under a minute".
 */
export function formatCallDuration(startedAt: Date | null, endedAt: Date): string {
  if (!startedAt) return 'under a minute'
  const minutes = Math.floor((endedAt.getTime() - startedAt.getTime()) / MINUTE_MS)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** Elapsed milliseconds as a running `mm:ss` clock; minutes are not capped at 59. */
export function formatCallClock(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
