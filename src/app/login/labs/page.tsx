'use client'
import { notFound } from 'next/navigation'
import { StaffLoginForm } from '@/components/StaffLoginForm'
import { getStaffPortal } from '@/lib/staff-portals'

export default function LoginLabsPage() {
  const portal = getStaffPortal('labs')
  if (!portal) notFound()
  return <StaffLoginForm portal={portal} />
}
