import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ClipboardPlus } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { BILLING_AUTHORITY_ROLES, CHARGE_CAPTURE_ROLES } from '@/lib/role-policy'
import { formatPaise } from '@/lib/format'
import { formatIsoDate, todayIsoIn } from '@/lib/india-time'
import {
  getCaptureHeader, getPharmacyCaptureView, listCaptureContexts, listChargeLinesForContext, listUnbilledPharmacyPatients, type ChargeContextRef,
} from '@/lib/queries/charge-capture'
import type { ChargeLineRow } from '@/db/schema'
import { ChargeCaptureForm } from '@/components/billing/ChargeCaptureForm'
import { ChargeLinesTable, type ChargeLineView } from '@/components/billing/ChargeLinesTable'
import { RoomRentButton } from '@/components/billing/RoomRentButton'
import { BackLink } from '@/components/BackLink'

const ID = /^[1-9]\d{0,9}$/

const PATIENT_ID = /^[A-Za-z0-9_-]{1,40}$/

type Ref = ChargeContextRef | { pharmacyPatientId: string }

function parseRef(sp: { encounterId?: string; admissionId?: string; patientId?: string }): Ref | null | 'none' {
  const { encounterId, admissionId, patientId } = sp
  const given = [encounterId, admissionId, patientId].filter((v) => v !== undefined).length
  if (given === 0) return 'none'
  if (given > 1) return null
  if (patientId !== undefined) return PATIENT_ID.test(patientId) ? { pharmacyPatientId: patientId } : null
  const raw = (encounterId ?? admissionId)!
  if (!ID.test(raw) || Number(raw) > 2_147_483_647) return null
  return encounterId !== undefined ? { encounterId: Number(raw) } : { admissionId: Number(raw) }
}

function PageTitle({ subtitle }: { subtitle: string }) {
  return (
    <div className="mb-6 flex items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
        <ClipboardPlus className="h-5 w-5" />
      </span>
      <div>
        <h1 className="text-2xl font-bold text-foreground">Charge Capture</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  )
}

const toLineView = (l: ChargeLineRow): ChargeLineView => ({
  id: l.id, serviceDate: l.serviceDate, itemCode: l.itemCode, itemName: l.itemName, quantity: l.quantity, unitPricePaise: l.unitPricePaise,
  taxablePaise: l.taxablePaise, priceSource: l.priceSource, status: l.status, invoiceId: l.invoiceId, source: l.source,
  violations: l.violations, voidReason: l.voidReason,
})

// SP4: capture charges against a visit or an admission (CHARGE_CAPTURE_ROLES = BILLING_ROLES).
export default async function ChargeCapturePage({ searchParams }: { searchParams: Promise<{ encounterId?: string; admissionId?: string; patientId?: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!CHARGE_CAPTURE_ROLES.includes(session.role)) redirect('/')

  const ref = parseRef(await searchParams)
  if (ref === null) notFound()

  if (ref === 'none') {
    const today = todayIsoIn()
    const [{ encounters, admissions }, pharmacy] = await Promise.all([listCaptureContexts(today), listUnbilledPharmacyPatients()])
    return (
      <div>
        <PageTitle subtitle={`Choose a visit or an admitted patient to add charges. Today is ${formatIsoDate(today)}.`} />
        <div className="grid gap-6 lg:grid-cols-2">
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Today&apos;s outpatient visits</h2>
            {encounters.length === 0 ? <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No visits today.</p> : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {encounters.map((e) => (
                  <li key={e.id}>
                    <Link href={`/billing/capture?encounterId=${e.id}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-muted">
                      <span>
                        <span className="font-medium">{e.patientName}</span>
                        <span className="block text-xs text-muted-foreground">{e.uhid ?? e.patientId} · {e.providerName}{e.departmentName ? ` · ${e.departmentName}` : ''}</span>
                      </span>
                      {e.opdToken !== null && <span className="rounded bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums">Token {e.opdToken}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Admitted patients</h2>
            {admissions.length === 0 ? <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No patients admitted.</p> : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {admissions.map((a) => (
                  <li key={a.id}>
                    <Link href={`/billing/capture?admissionId=${a.id}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-muted">
                      <span>
                        <span className="font-medium">{a.patientName}</span>
                        <span className="block text-xs text-muted-foreground">{a.uhid ?? a.patientId} · admitted {formatIsoDate(a.admittedOn)}</span>
                      </span>
                      {a.ward && <span className="text-xs text-muted-foreground">{a.ward}{a.roomNumber ? ` · ${a.roomNumber}` : ''}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        {pharmacy.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Unbilled pharmacy charges (no visit or stay)</h2>
            <ul className="divide-y divide-border rounded-md border border-border">
              {pharmacy.map((p) => (
                <li key={p.patientId}>
                  <Link href={`/billing/capture?patientId=${encodeURIComponent(p.patientId)}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-muted">
                    <span>
                      <span className="font-medium">{p.patientName}</span>
                      <span className="block text-xs text-muted-foreground">{p.uhid ?? p.patientId} · {p.lineCount} {p.lineCount === 1 ? 'charge' : 'charges'}</span>
                    </span>
                    <span className="tabular-nums">{formatPaise(p.taxablePaise)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    )
  }

  if ('pharmacyPatientId' in ref) {
    const view = await getPharmacyCaptureView(ref.pharmacyPatientId)
    if (!view) notFound()
    await logAudit(session, 'billing: viewed charge capture', view.patientId)
    return (
      <div>
        <div className="mb-4"><BackLink href="/billing/capture" label="All visits and admissions" /></div>
        <PageTitle subtitle={`Pharmacy charges with no visit or stay · ${view.patientName} · UHID ${view.uhid ?? '—'}`} />
        <section>
          <h2 className="mb-2 text-lg font-semibold">Charges</h2>
          <ChargeLinesTable lines={view.lines.map(toLineView)} />
        </section>
      </div>
    )
  }

  const header = await getCaptureHeader(ref)
  if (!header) notFound()
  const lines = await listChargeLinesForContext(ref)
  await logAudit(session, 'billing: viewed charge capture', header.patientId)

  return (
    <div>
      <div className="mb-4"><BackLink href="/billing/capture" label="All visits and admissions" /></div>
      <PageTitle subtitle={header.label} />
      <section className="mb-6 grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-4">
        <div><p className="text-xs text-muted-foreground">Patient</p><p className="font-semibold">{header.patientName}</p></div>
        <div><p className="text-xs text-muted-foreground">UHID</p><p className="font-medium">UHID {header.uhid ?? '—'}</p></div>
        <div><p className="text-xs text-muted-foreground">Primary payer</p><p className="font-medium">{header.payerName ?? 'Self-pay'}</p></div>
        {header.depositPaise !== null && (
          <div><p className="text-xs text-muted-foreground">Deposit (advances less refunds)</p><p className="font-medium tabular-nums">{formatPaise(header.depositPaise)}</p></div>
        )}
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Charges</h2>
            {'admissionId' in ref && <RoomRentButton admissionId={ref.admissionId} />}
          </div>
          <ChargeLinesTable lines={lines.map(toLineView)} />
        </section>
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 text-lg font-semibold">Add a charge</h2>
          <ChargeCaptureForm context={ref} canOverride={BILLING_AUTHORITY_ROLES.includes(session.role)} hasPayer={header.primaryPayerId !== null} today={todayIsoIn()} patientId={header.patientId} />
        </section>
      </div>
    </div>
  )
}
