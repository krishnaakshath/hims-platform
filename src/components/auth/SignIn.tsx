'use client'
import { useState } from 'react'
import { AudienceSwitch, type Audience } from '@/components/auth/AudienceSwitch'
import { DepartmentMenu } from '@/components/auth/DepartmentMenu'
import { PatientSignInForm } from '@/components/auth/PatientSignInForm'
import { StaffSignInForm } from '@/components/auth/StaffSignInForm'
import { ShellChart } from '@/components/auth/ShellChart'
import { ShellImmersive } from '@/components/auth/ShellImmersive'
import { ShellType } from '@/components/auth/ShellType'
import { useDesign } from '@/components/auth/auth-common'
import { rise } from '@/components/auth/auth-styles'
import type { StaffPortal } from '@/components/StaffLoginForm'

export const PATIENT_SIGN_IN_PATH = '/patient-portal/login'

// The whole sign-in experience behind /login, /login/<key> and
// /patient-portal/login. The Staff/Patient switch swaps the form in place and
// updates the URL with history.replaceState (integrated with the Next
// router; see node_modules/next/dist/docs/01-app/01-getting-started/
// 04-linking-and-navigating.md "Native History API"), so the shell never
// re-mounts or moves.
//
// REVIEW ONLY: three concepts (?design=a|b|c, see useDesign) share this
// logic and the forms, each with its own shell. The unchosen two go away.
export function SignIn({ audience: initial, portal }: { audience: Audience; portal?: StaffPortal }) {
  const design = useDesign()
  const [audience, setAudience] = useState<Audience>(initial)

  function switchTo(next: Audience) {
    if (next === audience) return
    setAudience(next)
    const href = next === 'patient' ? PATIENT_SIGN_IN_PATH : portal ? `/login/${portal.key}` : '/login'
    window.history.replaceState(null, '', href + window.location.search)
  }

  const switcher = <AudienceSwitch value={audience} onChange={switchTo} design={design} />
  const form =
    audience === 'staff' ? (
      <StaffSignInForm key={`staff-${design}`} design={design} portal={portal} below={<DepartmentMenu currentKey={portal?.key} design={design} />} />
    ) : (
      <PatientSignInForm key={`patient-${design}`} design={design} />
    )

  if (design === 'c') return <ShellType switcher={switcher}>{form}</ShellType>

  const body = (
    <>
      <div className={`auth-rise ${design === 'b' ? 'mb-6' : 'mb-7'}`} style={rise(0)}>
        {switcher}
      </div>
      {form}
    </>
  )
  return design === 'b' ? <ShellChart audience={audience}>{body}</ShellChart> : <ShellImmersive>{body}</ShellImmersive>
}
