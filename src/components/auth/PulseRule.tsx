// A short heartbeat rule in the brand accent above each sign-in heading: the
// same pulse as the brand mark and the panel trace, drawn in once on load.
export function PulseRule() {
  return (
    <svg aria-hidden="true" viewBox="0 0 96 16" className="mb-5 h-4 w-24 text-primary" fill="none">
      <path className="auth-draw" pathLength={1} d="M1 8h34l4-5 5 10 4-13 5 16 3-8h39" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
