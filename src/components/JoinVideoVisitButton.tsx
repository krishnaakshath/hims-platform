'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { TelemedicineCallScreen } from '@/components/TelemedicineCallScreen'
import type { TelemedicineSessionStatus } from '@/lib/queries/telemedicine-sessions'

// A patient joining from a text/email link shouldn't see a camera/mic
// permission prompt fire the instant the page loads -- spec §4's explicit
// "requests camera/mic permission on click, not on page load" requirement.
// TelemedicineCallScreen's getUserMedia call happens in its own mount
// effect, so gating *that* on a click means gating mounting the component
// itself on a click, which is what this wrapper does.
export function JoinVideoVisitButton({ pollUrl, initialStatus }: { pollUrl: string; initialStatus: TelemedicineSessionStatus }) {
  const [joined, setJoined] = useState(false)

  if (joined) {
    return <TelemedicineCallScreen role="patient" pollUrl={pollUrl} initialStatus={initialStatus} />
  }

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p className="text-sm text-muted-foreground">When you&apos;re ready, join the call below. Your browser will ask for camera and microphone access.</p>
      <Button type="button" onClick={() => setJoined(true)}>Join Video Visit</Button>
    </div>
  )
}
