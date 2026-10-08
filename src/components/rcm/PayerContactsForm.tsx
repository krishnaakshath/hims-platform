'use client'
import { useState } from 'react'
import { useRcmAction } from './useRcmAction'
import { FormError, Panel, buttonClass, inputClass, secondaryButtonClass } from './ui'

type Contact = { name: string; designation: string; phone: string; email: string; isEscalation: boolean }

export function PayerContactsForm({ payerId, initial }: { payerId: number; initial: Contact[] }) {
  const [rows, setRows] = useState<Contact[]>(initial)
  const run = useRcmAction()
  const set = (i: number, k: keyof Contact, val: string | boolean) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: val } : x)))
  return (
    <Panel title="Contacts">
      <div className="space-y-2">
        {rows.map((c, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-6">
            <input aria-label="Contact name" className={inputClass} placeholder="Name" value={c.name} onChange={(e) => set(i, 'name', e.target.value)} />
            <input aria-label="Designation" className={inputClass} placeholder="Designation" value={c.designation} onChange={(e) => set(i, 'designation', e.target.value)} />
            <input aria-label="Phone" className={inputClass} placeholder="Phone" value={c.phone} onChange={(e) => set(i, 'phone', e.target.value)} />
            <input aria-label="Email" className={inputClass} placeholder="Email" value={c.email} onChange={(e) => set(i, 'email', e.target.value)} />
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={c.isEscalation} onChange={(e) => set(i, 'isEscalation', e.target.checked)} />Escalation</label>
            <button type="button" className={secondaryButtonClass} onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <div className="flex gap-2">
          <button type="button" className={secondaryButtonClass} onClick={() => setRows((r) => [...r, { name: '', designation: '', phone: '', email: '', isEscalation: false }])}>Add contact</button>
          <button type="button" className={buttonClass} disabled={run.busy} onClick={() => run.send(`/api/rcm/payers/${payerId}/contacts`, 'PUT', {
            contacts: rows.map((c) => ({ name: c.name.trim(), isEscalation: c.isEscalation, ...(c.designation.trim() ? { designation: c.designation.trim() } : {}), ...(c.phone.trim() ? { phone: c.phone.trim() } : {}), ...(c.email.trim() ? { email: c.email.trim() } : {}) })),
          })}>Save contacts</button>
        </div>
        <FormError error={run.error} />
      </div>
    </Panel>
  )
}
