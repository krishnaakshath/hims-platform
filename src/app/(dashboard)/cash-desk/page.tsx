import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Banknote } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { BILLING_AUTHORITY_ROLES, CASH_DESK_ROLES, CHARGE_CAPTURE_ROLES, CHARGES_ROLES } from '@/lib/role-policy'
import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import { findPatientForCashDesk, getPatientLedger, listPayableInvoices } from '@/lib/queries/patient-ledger'
import { CashDeskPanel } from '@/components/billing/CashDeskPanel'
import { Balance, LedgerTable } from '@/components/billing/LedgerTable'
import { FIELD_CLASS } from '@/components/tariff/api'

// SP4 cash desk (CASH_DESK_ROLES: admin, billing, crc, frontdesk). Record-keeping only.
export default async function CashDeskPage({ searchParams }: { searchParams: Promise<{ q?: string; patientId?: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!CASH_DESK_ROLES.includes(session.role)) redirect('/')

  const sp = await searchParams
  const q = typeof sp.q === 'string' ? sp.q.trim().slice(0, 60) : ''
  const patientId = typeof sp.patientId === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(sp.patientId) ? sp.patientId : null
  if (sp.patientId !== undefined && patientId === null) notFound()

  const results = q ? await findPatientForCashDesk(q) : []
  const ledger = patientId ? await getPatientLedger(patientId) : null
  if (patientId && !ledger) notFound()
  const invoices = ledger ? await listPayableInvoices(ledger.patient.id) : []
  if (ledger) await logAudit(session, 'billing: viewed patient ledger', ledger.patient.id)
  const legacyLinks = CHARGES_ROLES.includes(session.role)

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true"><Banknote className="h-5 w-5" /></span>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Cash Desk</h1>
          <p className="text-sm text-muted-foreground">Advances, payments and refunds, with the patient&apos;s running account.</p>
        </div>
      </div>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="desk-q" className="mb-1 block text-xs font-medium text-muted-foreground">Find patient (UHID, patient ID or name)</label>
          <input id="desk-q" name="q" defaultValue={q} className={`${FIELD_CLASS} w-72`} />
        </div>
        <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">Search</button>
      </form>

      {q && (
        results.length === 0 ? <p className="mb-6 text-sm text-muted-foreground">No patient matches “{q}”.</p> : (
          <ul className="mb-6 divide-y divide-border rounded-md border border-border">
            {results.map((p) => (
              <li key={p.id}>
                <Link href={`/cash-desk?patientId=${encodeURIComponent(p.id)}`} className="block px-4 py-2 text-sm hover:bg-muted">
                  <span className="font-medium">{p.name}</span> <span className="text-muted-foreground">· {p.uhid ?? p.id}</span>
                </Link>
              </li>
            ))}
          </ul>
        )
      )}

      {ledger && (
        <div className="space-y-6">
          <section className="flex flex-wrap items-end justify-between gap-4 rounded-lg border border-border bg-card p-4">
            <div>
              <p className="text-lg font-semibold">{ledger.patient.name}</p>
              <p className="text-sm text-muted-foreground">UHID {ledger.patient.uhid ?? '—'} · {ledger.activeAdmissionId !== null ? `Admitted (admission ${ledger.activeAdmissionId})` : 'Not admitted'}</p>
            </div>
            <dl className="grid grid-cols-3 gap-6 text-right">
              <div><dt className="text-xs text-muted-foreground">Outstanding</dt><dd className="text-lg font-semibold tabular-nums">{formatPaise(ledger.ledger.summary.outstandingPaise)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Credit</dt><dd className="text-lg font-semibold tabular-nums">{formatPaise(ledger.ledger.summary.creditBalancePaise)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Not yet billed (estimate)</dt><dd className="text-lg font-semibold tabular-nums">{formatPaise(ledger.unbilledPaise)}</dd></div>
            </dl>
          </section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <section>
              <h2 className="mb-2 text-lg font-semibold">Account</h2>
              <LedgerTable rows={ledger.ledger.rows} invoiceLinks={CHARGE_CAPTURE_ROLES.includes(session.role)} />
              <p className="mt-2 text-right text-sm text-muted-foreground">Balance: <Balance paise={ledger.ledger.summary.balancePaise} /></p>

              {ledger.legacyCharges.length > 0 && (
                <div className="mt-6">
                  <h3 className="mb-1 text-sm font-semibold">Legacy charges (before charge capture)</h3>
                  <p className="mb-2 text-xs text-muted-foreground">Kept on their own collections screens; not part of the account above.</p>
                  <ul className="divide-y divide-border rounded-md border border-border text-sm">
                    {ledger.legacyCharges.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <span>
                          <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">Legacy</span>
                          {legacyLinks ? <Link href={`/billing/charges/${c.id}`} className="text-primary hover:underline">Charge #{c.id}</Link> : <span>Charge #{c.id}</span>}
                          <span className="ml-2 text-muted-foreground">{formatIsoDate(c.dateOfService)} · {c.status}</span>
                        </span>
                        <span className="tabular-nums">{formatPaise(c.amountPaise)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
            <section>
              <h2 className="mb-2 text-lg font-semibold">Take money</h2>
              <CashDeskPanel patientId={ledger.patient.id} admissionId={ledger.activeAdmissionId} finalisedInvoices={invoices} canRefund={BILLING_AUTHORITY_ROLES.includes(session.role)} />
            </section>
          </div>
        </div>
      )}
    </div>
  )
}
