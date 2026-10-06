export type Verdict = 'green' | 'yellow' | 'red'

/**
 * Never guesses green: an empty evidence set defaults to yellow
 * (per the "no guessing" rule in the client proposal, §2 rule 2).
 */
export function evaluateCriteria(results: { verdict: Verdict }[]): Verdict {
  if (results.length === 0) return 'yellow'
  if (results.some((r) => r.verdict === 'red')) return 'red'
  if (results.some((r) => r.verdict === 'yellow')) return 'yellow'
  return 'green'
}
