import { AUTH_PRIMARY_BUTTON } from '@/components/auth/auth-styles'

// The primary "Sign in" button: fixed size in every state (idle, signing in,
// signed in), so the label swap never changes its width or height.
export function SubmitButton({ disabled, submitting, done, label = 'Sign in' }: { disabled: boolean; submitting: boolean; done: boolean; label?: string }) {
  return (
    <button type="submit" disabled={disabled} className={`${AUTH_PRIMARY_BUTTON} ${done ? '!opacity-100' : ''}`}>
      {done ? (
        <>
          <svg aria-hidden="true" viewBox="0 0 20 20" className="auth-pop h-5 w-5" fill="none">
            <path className="auth-draw" pathLength={1} d="M4.5 10.5l3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Signed in
        </>
      ) : submitting ? (
        <>
          <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" />
          Signing in
        </>
      ) : (
        label
      )}
    </button>
  )
}
