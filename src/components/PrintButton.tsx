'use client'
import { Button } from '@/components/ui/button'

// Explicit click only -- NO useEffect and NO auto-window.print() on mount.
// This is an authenticated PHI page; firing a print dialog before the
// reader has confirmed it is the right patient is a mis-print waiting to
// happen. Do not "improve" this by auto-printing on load.
export function PrintButton() {
  return <Button type="button" onClick={() => window.print()}>Print</Button>
}
