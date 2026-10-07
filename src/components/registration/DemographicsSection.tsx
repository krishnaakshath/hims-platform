'use client'
import { Field, INPUT_CLASS, SectionHeading } from './Field'
import type { SectionProps } from './registration-form-state'
import { GENDERS, MARITAL_STATUSES, BLOOD_GROUPS, LANGUAGES } from '@/lib/india/reference'

export function DemographicsSection({ form, update, errors }: SectionProps) {
  return (
    <section aria-label="Basic info" className="space-y-3">
      <SectionHeading>Basic info</SectionHeading>
      <Field label="Full name" required error={errors.name}>
        {(p) => <input {...p} value={form.name} onChange={(e) => update('name', e.target.value)} autoComplete="off" className={INPUT_CLASS} />}
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Date of birth" required error={errors.dob}>
          {(p) => <input {...p} type="date" value={form.dob} onChange={(e) => update('dob', e.target.value)} className={INPUT_CLASS} />}
        </Field>
        <Field label="Gender" required error={errors.gender}>
          {(p) => (
            <select {...p} value={form.gender} onChange={(e) => update('gender', e.target.value)} className={INPUT_CLASS}>
              <option value="">Select</option>
              {GENDERS.map((g) => <option key={g.code} value={g.code}>{g.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Marital status" error={errors.maritalStatus}>
          {(p) => (
            <select {...p} value={form.maritalStatus} onChange={(e) => update('maritalStatus', e.target.value)} className={INPUT_CLASS}>
              <option value="">Select</option>
              {MARITAL_STATUSES.map((g) => <option key={g.code} value={g.code}>{g.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Blood group" error={errors.bloodGroup}>
          {(p) => (
            <select {...p} value={form.bloodGroup} onChange={(e) => update('bloodGroup', e.target.value)} className={INPUT_CLASS}>
              <option value="">Select</option>
              {BLOOD_GROUPS.map((g) => <option key={g.code} value={g.code}>{g.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Mobile number" error={errors.phone}>
          {(p) => <input {...p} type="tel" inputMode="tel" value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="10-digit mobile" className={INPUT_CLASS} />}
        </Field>
        <Field label="Email" error={errors.email}>
          {(p) => <input {...p} type="email" value={form.email} onChange={(e) => update('email', e.target.value)} className={INPUT_CLASS} />}
        </Field>
        <Field label="Preferred language" error={errors.preferredLanguage}>
          {(p) => (
            <select {...p} value={form.preferredLanguage} onChange={(e) => update('preferredLanguage', e.target.value)} className={INPUT_CLASS}>
              <option value="">Select</option>
              {LANGUAGES.map((g) => <option key={g.code} value={g.code}>{g.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Occupation" error={errors.occupation}>
          {(p) => <input {...p} value={form.occupation} onChange={(e) => update('occupation', e.target.value)} className={INPUT_CLASS} />}
        </Field>
        <Field label="Religion" error={errors.religion}>
          {(p) => <input {...p} value={form.religion} onChange={(e) => update('religion', e.target.value)} className={INPUT_CLASS} />}
        </Field>
        <Field label="Nationality (country code)" error={errors.nationality}>
          {(p) => <input {...p} value={form.nationality} maxLength={2} onChange={(e) => update('nationality', e.target.value.toUpperCase())} className={INPUT_CLASS} />}
        </Field>
      </div>
    </section>
  )
}
