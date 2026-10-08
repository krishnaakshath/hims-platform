'use client'
import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AadhaarPanel } from './AadhaarPanel'
import { EditPatientProfileModal } from './EditPatientProfileModal'
import { NotificationPreferenceToggle } from './NotificationPreferenceToggle' // SP5
import { formatAbhaNumber } from '@/lib/india/abha'
import {
  stateName, GENDERS, MARITAL_STATUSES, BLOOD_GROUPS, LANGUAGES, ABHA_UNAVAILABLE_REASONS,
} from '@/lib/india/reference'
import type { AadhaarView } from '@/lib/patient-identity'

export interface ProfileContact {
  kind: 'next_of_kin' | 'guardian' | 'emergency'
  name: string
  relationship: string
  phone: string
  addressText: string | null
  isPrimary: boolean
}

// Structurally the patient detail read model's profile columns plus contacts; nothing
// about Aadhaar is in here (that arrives separately as the role view).
export interface ProfileView {
  id: string
  uhid: string | null
  gender: string | null
  maritalStatus: string | null
  bloodGroup: string | null
  occupation: string | null
  nationality: string | null
  religion: string | null
  preferredLanguage: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  district: string | null
  stateCode: string | null
  pinCode: string | null
  phone: string | null
  email: string | null
  abhaNumber: string | null
  abhaAddress: string | null
  abhaUnavailableReason: string | null
  // Wave C P2-11: prefilled in the edit form (optional for older callers).
  abhaUnavailableNote?: string | null
  isMlc: boolean
  mlcNumber: string | null
  contacts: ProfileContact[]
  notificationOptOut?: boolean // SP5
}

const KIND_LABELS: Record<ProfileContact['kind'], string> = { next_of_kin: 'Next of kin', guardian: 'Guardian', emergency: 'Emergency contact' }

const labelOf = (list: readonly { code: string; label: string }[], code: string | null) =>
  code ? list.find((x) => x.code === code)?.label ?? code : null

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm text-foreground">{value || <span className="text-muted-foreground">Not recorded</span>}</dd>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-card p-5 shadow-none">
      <h2 className="mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

export function PatientProfilePanel({ patient, aadhaar, canEdit, canWriteAadhaar, canUnflagMlc = false, canEditNotifications = false }: {
  patient: ProfileView
  aadhaar: AadhaarView
  canEdit: boolean
  canWriteAadhaar: boolean
  canEditNotifications?: boolean // SP5: NOTIFICATION_PREFERENCE_ROLES
  // Wave C P2-11: MLC_UNFLAG_ROLES -- may clear an MLC flag already on file.
  canUnflagMlc?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const abhaNumber = patient.abhaNumber && /^\d{14}$/.test(patient.abhaNumber) ? formatAbhaNumber(patient.abhaNumber) : patient.abhaNumber
  const hasAbha = Boolean(abhaNumber || patient.abhaAddress)
  const state = patient.stateCode ? stateName(patient.stateCode) ?? patient.stateCode : null
  const addressLines = [patient.addressLine1, patient.addressLine2].filter(Boolean).join(', ')
  const cityLine = [patient.city, patient.district, state].filter(Boolean).join(', ')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {patient.isMlc && (
            <span className="rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-0.5 text-xs font-semibold text-destructive" title={patient.mlcNumber ? `MLC number ${patient.mlcNumber}` : undefined}>MLC</span>
          )}
          {patient.isMlc && patient.mlcNumber && <span className="text-xs text-muted-foreground">No. {patient.mlcNumber}</span>}
        </div>
        {canEdit && (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit profile
          </Button>
        )}
      </div>

      <Group title="Demographics">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Item label="Gender" value={labelOf(GENDERS, patient.gender)} />
          <Item label="Marital status" value={labelOf(MARITAL_STATUSES, patient.maritalStatus)} />
          <Item label="Blood group" value={labelOf(BLOOD_GROUPS, patient.bloodGroup)} />
          <Item label="Occupation" value={patient.occupation} />
          <Item label="Nationality" value={patient.nationality} />
          <Item label="Religion" value={patient.religion} />
          <Item label="Preferred language" value={labelOf(LANGUAGES, patient.preferredLanguage)} />
          <Item label="Phone" value={patient.phone} />
          <Item label="Email" value={patient.email} />
        </dl>
      </Group>

      <Group title="Address">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Item label="Street" value={addressLines} />
          <Item label="City, district, state" value={cityLine} />
          <Item label="PIN code" value={patient.pinCode} />
        </dl>
      </Group>

      <Group title="National identity">
        <dl className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Item label="ABHA number" value={abhaNumber ? <span className="font-mono">{abhaNumber}</span> : null} />
          <Item label="ABHA address" value={patient.abhaAddress} />
          {!hasAbha && patient.abhaUnavailableReason && <Item label="ABHA" value={`Not available — ${labelOf(ABHA_UNAVAILABLE_REASONS, patient.abhaUnavailableReason)}`} />}
        </dl>
        <AadhaarPanel anonId={patient.id} view={aadhaar} canWrite={canWriteAadhaar} />
      </Group>

      <Group title="Contacts and guardian">
        {patient.contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No contacts recorded.</p>
        ) : (
          <ul className="space-y-2">
            {patient.contacts.map((c, i) => (
              <li key={i} className="text-sm text-foreground">
                <span className="font-medium">{c.name}</span>
                <span className="text-muted-foreground"> · {KIND_LABELS[c.kind]} · {c.relationship.charAt(0).toUpperCase() + c.relationship.slice(1)} · {c.phone}</span>
                {c.addressText && <span className="block text-xs text-muted-foreground">{c.addressText}</span>}
              </li>
            ))}
          </ul>
        )}
      </Group>

      {/* SP5 */}
      {canEditNotifications && (
        <Group title="Notifications">
          <NotificationPreferenceToggle anonId={patient.id} initialOptOut={patient.notificationOptOut ?? false} />
        </Group>
      )}

      {canEdit && editing && <EditPatientProfileModal patient={patient} canUnflagMlc={canUnflagMlc} onClose={() => setEditing(false)} />}
    </div>
  )
}
