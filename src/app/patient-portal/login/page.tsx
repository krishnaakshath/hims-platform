'use client'
import { SignIn } from '@/components/auth/SignIn'

// Same sign-in experience as /login with the Patient side of the switch
// selected; the form itself lives in components/auth/PatientSignInForm.
export default function PatientPortalLoginPage() {
  return <SignIn audience="patient" />
}
