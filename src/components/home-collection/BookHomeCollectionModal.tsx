'use client'
// SP5: book a home sample collection. Find the patient (id or UHID), tick the waiting lab tests,
// pick a date and window, confirm the visit address (prefilled from the registered address,
// editable: the visit PIN decides whether the lab can travel there) and the contact phone.
import { useId, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { HomeCollectionContext } from '@/lib/queries/home-collections'
import { bookHomeCollectionSchema } from '@/lib/labs/validation'
import { INDIAN_STATES } from '@/lib/india/reference'
import { displaySampleId } from '@/lib/labs/sample-id'
import { SAMPLE_CONTAINER_LABEL } from '@/lib/labs/catalog'
import { bookVisit, fetchBookingContext, labelsHref } from '@/components/home-collection/api'
import { FIELD, WindowSelect } from '@/components/home-collection/WindowSelect'

const NOT_LOCAL_NOTE = 'Outside the service area: walk-in only'

interface AddressForm { line1: string; line2: string; city: string; district: string; stateCode: string; pinCode: string; landmark: string }

const opt = (s: string) => (s.trim() === '' ? undefined : s.trim())

export function BookHomeCollectionModal({ date, onClose }: { date: string; onClose: () => void }) {
  const router = useRouter()
  const id = useId()
  const [lookup, setLookup] = useState('')
  const [finding, setFinding] = useState(false)
  const [context, setContext] = useState<HomeCollectionContext | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [visitDate, setVisitDate] = useState(date)
  const [windowId, setWindowId] = useState('')
  const [address, setAddress] = useState<AddressForm>({ line1: '', line2: '', city: '', district: '', stateCode: '', pinCode: '', landmark: '' })
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [booked, setBooked] = useState<{ sampleIds: [number, string][] } | null>(null)

  async function find() {
    setError(null)
    if (!lookup.trim()) { setError('Enter a patient ID or UHID.'); return }
    setFinding(true)
    const r = await fetchBookingContext(lookup.trim())
    setFinding(false)
    if (!r.ok) { setContext(null); setError(r.error); return }
    const p = r.data.patient
    setContext(r.data)
    setSelected(r.data.bookableOrders.map((o) => o.id))
    setAddress({
      line1: p.addressLine1 ?? '', line2: p.addressLine2 ?? '', city: p.city ?? '', district: p.district ?? '',
      stateCode: p.stateCode ?? '', pinCode: p.pinCode ?? '', landmark: '',
    })
    setPhone(p.phone ?? '')
  }

  function toggle(orderId: number) {
    setSelected((s) => (s.includes(orderId) ? s.filter((x) => x !== orderId) : [...s, orderId]))
  }

  async function submit() {
    if (!context) return
    setError(null)
    const parsed = bookHomeCollectionSchema.safeParse({
      patientId: context.patient.id,
      // Keep the context's order (oldest first).
      labOrderIds: context.bookableOrders.filter((o) => selected.includes(o.id)).map((o) => o.id),
      visitDate,
      windowId: Number(windowId),
      address: {
        line1: address.line1.trim(), line2: opt(address.line2), city: address.city.trim(), district: opt(address.district),
        stateCode: address.stateCode, pinCode: address.pinCode.trim(), landmark: opt(address.landmark),
      },
      contactPhone: phone,
      notes: opt(notes),
    })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const field = issue?.path[0]
      setError(
        issue?.code === 'custom' || issue?.code === 'invalid_format' ? issue.message
          : field === 'labOrderIds' ? 'Tick at least one test.'
            : field === 'windowId' ? 'Pick a collection window.'
              : field === 'visitDate' ? 'Pick a valid date.'
                : 'Check the address: line 1, city, state and PIN are required.',
      )
      return
    }
    setSubmitting(true)
    const r = await bookVisit(parsed.data)
    setSubmitting(false)
    if (!r.ok) { setError(r.error); return }
    setBooked({ sampleIds: Object.entries(r.data.sampleIds).map(([k, v]) => [Number(k), v] as [number, string]) })
    router.refresh()
  }

  const setField = (k: keyof AddressForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setAddress((a) => ({ ...a, [k]: e.target.value }))
  const testName = (orderId: number) => context?.bookableOrders.find((o) => o.id === orderId)?.testName ?? `Order ${orderId}`

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New home collection</DialogTitle>
        </DialogHeader>
        {booked ? (
          <div className="space-y-3">
            <p role="status" className="text-sm font-medium">Home collection booked.</p>
            {booked.sampleIds.length > 0 && (
              <ul className="space-y-1 text-sm">
                {booked.sampleIds.map(([orderId, sampleId]) => (
                  <li key={orderId} className="flex justify-between gap-3">
                    <span>{testName(orderId)}</span>
                    <span className="font-mono">{displaySampleId(sampleId)}</span>
                  </li>
                ))}
              </ul>
            )}
            <DialogFooter>
              {booked.sampleIds.length > 0 && (
                <Link href={labelsHref(booked.sampleIds.map(([o]) => o))} className="text-sm font-medium text-primary underline">Print labels</Link>
              )}
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="max-h-[65vh] space-y-3 overflow-y-auto">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label htmlFor={`${id}-patient`} className="block text-xs text-muted-foreground">Patient ID or UHID</label>
                  <input
                    id={`${id}-patient`} value={lookup} onChange={(e) => setLookup(e.target.value)} className={FIELD} autoComplete="off"
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void find() } }}
                  />
                </div>
                <Button variant="outline" onClick={find} disabled={finding}>{finding ? 'Finding…' : 'Find patient'}</Button>
              </div>

              {context && (
                <>
                  <p className="text-sm">
                    <span className="font-medium">{context.patient.name}</span>
                    {context.patient.uhid && <span className="text-muted-foreground"> · {context.patient.uhid}</span>}
                  </p>
                  {!context.isLocal && <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">{NOT_LOCAL_NOTE}</p>}
                  {context.activeVisits.length > 0 && (
                    <p className="text-xs text-muted-foreground">Already booked: {context.activeVisits.map((v) => `${v.visitDate} ${v.windowLabel}`).join('; ')}</p>
                  )}

                  <fieldset className="space-y-1">
                    <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tests to collect</legend>
                    {context.bookableOrders.length === 0 && <p className="text-sm text-muted-foreground">No lab tests are waiting for collection.</p>}
                    {context.bookableOrders.map((o) => (
                      <label key={o.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
                        <span>{o.testName}</span>
                        {o.container && <span className="text-xs text-muted-foreground">({SAMPLE_CONTAINER_LABEL[o.container]})</span>}
                      </label>
                    ))}
                    {context.bookableOrderCount > context.bookableOrders.length && (
                      <p className="text-xs text-muted-foreground">Showing the first {context.bookableOrders.length} of {context.bookableOrderCount} tests. Book the rest in another visit.</p>
                    )}
                  </fieldset>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label htmlFor={`${id}-date`} className="block text-xs text-muted-foreground">Visit date</label>
                      <input id={`${id}-date`} type="date" value={visitDate} onChange={(e) => { setVisitDate(e.target.value); setWindowId('') }} className={FIELD} />
                    </div>
                    <WindowSelect id={`${id}-window`} date={visitDate} value={windowId} onChange={setWindowId} />
                  </div>

                  <fieldset className="space-y-2">
                    <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Visit address</legend>
                    <div>
                      <label htmlFor={`${id}-line1`} className="block text-xs text-muted-foreground">Address line 1</label>
                      <input id={`${id}-line1`} value={address.line1} onChange={setField('line1')} className={FIELD} />
                    </div>
                    <div>
                      <label htmlFor={`${id}-line2`} className="block text-xs text-muted-foreground">Address line 2 (optional)</label>
                      <input id={`${id}-line2`} value={address.line2} onChange={setField('line2')} className={FIELD} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label htmlFor={`${id}-city`} className="block text-xs text-muted-foreground">City / town</label>
                        <input id={`${id}-city`} value={address.city} onChange={setField('city')} className={FIELD} />
                      </div>
                      <div>
                        <label htmlFor={`${id}-district`} className="block text-xs text-muted-foreground">District (optional)</label>
                        <input id={`${id}-district`} value={address.district} onChange={setField('district')} className={FIELD} />
                      </div>
                      <div>
                        <label htmlFor={`${id}-state`} className="block text-xs text-muted-foreground">State</label>
                        <select id={`${id}-state`} value={address.stateCode} onChange={setField('stateCode')} className={FIELD}>
                          <option value="">Pick a state</option>
                          {INDIAN_STATES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`${id}-pin`} className="block text-xs text-muted-foreground">PIN code</label>
                        <input id={`${id}-pin`} value={address.pinCode} onChange={setField('pinCode')} inputMode="numeric" maxLength={6} className={FIELD} />
                      </div>
                    </div>
                    <div>
                      <label htmlFor={`${id}-landmark`} className="block text-xs text-muted-foreground">Landmark (optional)</label>
                      <input id={`${id}-landmark`} value={address.landmark} onChange={setField('landmark')} className={FIELD} />
                    </div>
                  </fieldset>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label htmlFor={`${id}-phone`} className="block text-xs text-muted-foreground">Contact phone</label>
                      <input id={`${id}-phone`} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={FIELD} />
                    </div>
                    <div>
                      <label htmlFor={`${id}-notes`} className="block text-xs text-muted-foreground">Notes for the collector (optional)</label>
                      <input id={`${id}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} className={FIELD} />
                    </div>
                  </div>
                </>
              )}

              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={submit} disabled={!context || selected.length === 0 || submitting}>{submitting ? 'Booking…' : 'Book collection'}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
