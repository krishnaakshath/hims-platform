'use client'
import { useState } from 'react'
import { AudienceSwitch, type Audience } from '@/components/auth/AudienceSwitch'
import { DepartmentMenu } from '@/components/auth/DepartmentMenu'
import { PatientSignInForm } from '@/components/auth/PatientSignInForm'
import { StaffSignInForm } from '@/components/auth/StaffSignInForm'
import { ShellChart } from '@/components/auth/ShellChart'
import { rise } from '@/components/auth/auth-styles'
import type { StaffPortal } from '@/components/StaffLoginForm'

export const PATIENT_SIGN_IN_PATH = '/patient-portal/login'

// The whole sign-in experience behind /login, /login/<key> and
// /patient-portal/login: the ID badge on ECG paper (ShellChart). The
// Staff/Patient switch swaps the form in place and updates the URL with
// history.replaceState (integrated with the Next router; see
// node_modules/next/dist/docs/01-app/01-getting-started/
// 04-linking-and-navigating.md "Native History API"), so the badge never
// re-mounts or moves.
export function SignIn({ audience: initial, portal }: { audience: Audience; portal?: StaffPortal }) {
  const [audience, setAudience] = useState<Audience>(initial)

  function switchTo(next: Audience) {
    if (next === audience) return
    setAudience(next)
    const href = next === 'patient' ? PATIENT_SIGN_IN_PATH : portal ? `/login/${portal.key}` : '/login'
    window.history.replaceState(null, '', href)
  }

  return (
    <ShellChart audience={audience}>
      <div className="auth-rise mb-6" style={rise(1)}>
        <AudienceSwitch value={audience} onChange={switchTo} />
      </div>
      {audience === 'staff' ? (
        <StaffSignInForm key="staff" portal={portal} below={<DepartmentMenu currentKey={portal?.key} />} />
      ) : (
        <PatientSignInForm key="patient" />
      )}
    </ShellChart>
  )
}
