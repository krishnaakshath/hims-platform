'use client'
import { notFound } from 'next/navigation'
import { StaffLoginForm } from '@/components/StaffLoginForm'
import { getStaffPortal } from '@/lib/staff-portals'

export default function LoginCollectorPage() {
  const portal = getStaffPortal('collector')
  if (!portal) notFound()
  return <StaffLoginForm portal={portal} />
}
