'use client'
import { useEffect, useRef, useState } from 'react'
import { todayIsoIn } from '@/lib/india-time'
import { Field, INPUT_CLASS } from './Field'

// WS6 T8 (spec D5, D6): on the Review step, the front desk picks the department the patient
// came to see and gets the earliest free OPD slot today among that department's clinical
// doctors ("Next available: Dr Rao today 11:30 · Room 4"). Registration itself has no
// department field, so this choice is advisory only and is not saved. Slots come from
// GET /api/providers/[id]/slots for at most MAX_DOCTORS doctors; the whole hint hides on a
// 404 (scheduling not deployed) or any other error.

interface Doctor { id: number; name: string; departmentId: number; departmentName: string; opdRoom: string | null }
interface Slot { startsAt: string; endsAt: string; status: string }

const MAX_DOCTORS = 5
const IST_OFFSET_MS = 330 * 60_000

const istClock = (iso: string) => new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(11, 16)
const doctorLabel = (name: string) => (/^dr\.?\s/i.test(name) ? name : `Dr ${name}`)

type Hint = { state: 'idle' } | { state: 'loading' } | { state: 'none' } | { state: 'hidden' } | { state: 'found'; text: string }

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`status ${res.status}`)
  return res.json()
}

export function NextAvailableHint() {
  const [doctors, setDoctors] = useState<Doctor[] | null>(null)
  const [departmentId, setDepartmentId] = useState('')
  const [hint, setHint] = useState<Hint>({ state: 'idle' })

  useEffect(() => {
    let live = true
    getJson('/api/providers')
      .then((data) => {
        const list = (data as { doctors?: unknown })?.doctors
        if (live) setDoctors(Array.isArray(list) ? (list as Doctor[]) : [])
      })
      .catch(() => { if (live) setDoctors([]) })
    return () => { live = false }
  }, [])

  const latest = useRef(0) // only the newest department choice may set the hint

  function choose(value: string) {
    setDepartmentId(value)
    const request = ++latest.current
    if (!value || !doctors) { setHint({ state: 'idle' }); return }
    const chosen = doctors.filter((d) => String(d.departmentId) === value).slice(0, MAX_DOCTORS)
    const date = todayIsoIn()
    setHint({ state: 'loading' })
    Promise.all(chosen.map(async (d) => {
      const data = (await getJson(`/api/providers/${d.id}/slots?date=${date}`)) as { slots?: Slot[] }
      const free = (Array.isArray(data.slots) ? data.slots : []).filter((s) => s.status === 'free')
      free.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
      return free[0] ? { doctor: d, slot: free[0] } : null
    }))
      .then((found) => {
        if (request !== latest.current) return
        const best = found
          .filter((f): f is { doctor: Doctor; slot: Slot } => f !== null)
          .sort((a, b) => Date.parse(a.slot.startsAt) - Date.parse(b.slot.startsAt))[0]
        if (!best) { setHint({ state: 'none' }); return }
        const room = best.doctor.opdRoom ? ` · Room ${best.doctor.opdRoom}` : ''
        setHint({ state: 'found', text: `Next available: ${doctorLabel(best.doctor.name)} today ${istClock(best.slot.startsAt)}${room}` })
      })
      .catch(() => { if (request === latest.current) setHint({ state: 'hidden' }) })
  }

  if (!doctors || doctors.length === 0) return null
  const departments = [...new Map(doctors.map((d) => [d.departmentId, d.departmentName])).entries()]

  return (
    <section aria-label="Doctor availability" className="space-y-2">
      <Field label="Department to see (optional)" hint="Shows the next free OPD slot today. Not saved with the registration.">
        {(p) => (
          <select {...p} value={departmentId} onChange={(e) => choose(e.target.value)} className={INPUT_CLASS}>
            <option value="">Select a department</option>
            {departments.map(([id, name]) => <option key={id} value={String(id)}>{name}</option>)}
          </select>
        )}
      </Field>
      {hint.state === 'loading' && <p className="text-xs text-muted-foreground">Checking today&apos;s slots...</p>}
      {hint.state === 'found' && <p role="status" className="text-sm font-medium text-foreground">{hint.text}</p>}
      {hint.state === 'none' && <p role="status" className="text-sm text-muted-foreground">No free OPD slot left today in this department.</p>}
    </section>
  )
}
