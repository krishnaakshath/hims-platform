import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import { stateName } from '@/lib/india/reference'
import { GST_STATE_CODES } from '@/lib/billing/gst'
import { sumPaise } from '@/lib/billing/amounts'
import { rupeesInWords } from '@/lib/billing/amount-words'
import type { InvoiceDetail } from '@/lib/queries/invoices'
import { bpToPercent } from './labels'

function placeLabel(stateCode: string | null): string {
  if (!stateCode) return 'Not set (add the hospital state in Billing rules & settings)'
  return `${stateName(stateCode) ?? stateCode} (${GST_STATE_CODES[stateCode] ?? '—'})`
}

function addressLines(p: InvoiceDetail['parties']['patient']): string[] {
  const cityLine = [p.city, p.district].filter(Boolean).join(', ')
  const stateLine = [p.stateCode ? stateName(p.stateCode) : null, p.pinCode].filter(Boolean).join(' – ')
  return [p.addressLine1, p.addressLine2, cityLine, stateLine].filter((l): l is string => Boolean(l))
}

/**
 * SP4: the GST invoice as a document, shared by the detail screen and the A4 print view.
 * Server-renderable (no hooks). Drafts read as a provisional bill with an estimated tax split;
 * a cancelled invoice carries its credit-note banner. Bill-to shows name, UHID and postal address
 * only, from the frozen snapshot once issued.
 */
export function InvoiceDocument({ invoice }: { invoice: InvoiceDetail }) {
  const { parties, place, lines } = invoice
  const draft = invoice.estimated
  const inter = place.supplyType === 'inter'
  const title = draft ? 'PROVISIONAL BILL — NOT A TAX INVOICE' : (invoice.documentTitle ?? 'Tax Invoice').toUpperCase()
  const sum = (pick: (l: (typeof lines)[number]) => number) => sumPaise(lines.map(pick))
  const totals = {
    taxable: invoice.taxablePaise ?? sum((l) => l.taxablePaise),
    cgst: invoice.cgstPaise ?? sum((l) => l.cgstPaise),
    sgst: invoice.sgstPaise ?? sum((l) => l.sgstPaise),
    igst: invoice.igstPaise ?? sum((l) => l.igstPaise),
    total: invoice.totalPaise ?? sum((l) => l.totalPaise),
  }
  const hospital = parties.hospital
  const th = 'border-b border-neutral-300 px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-600 print:text-black'
  const td = 'border-b border-neutral-200 px-2 py-2 align-top'

  return (
    <article className="mx-auto w-full max-w-[210mm] bg-white p-8 text-[13px] leading-relaxed text-neutral-900 shadow-sm ring-1 ring-neutral-200 print:max-w-none print:p-0 print:shadow-none print:ring-0 print:text-black">
      {invoice.status === 'cancelled' && (
        <p role="status" className="mb-4 rounded border-2 border-red-600 px-3 py-2 text-center text-sm font-bold tracking-wide text-red-700">
          CANCELLED — Credit note {invoice.creditNote?.creditNoteNumber ?? ''}
          {invoice.creditNote && <span className="block text-xs font-medium">Issued {formatIsoDate(invoice.creditNote.issueDate)}</span>}
        </p>
      )}
      {invoice.status === 'discarded' && (
        <p role="status" className="mb-4 rounded border-2 border-neutral-400 px-3 py-2 text-center text-sm font-bold tracking-wide text-neutral-600">DISCARDED DRAFT</p>
      )}

      <header className="flex items-start justify-between gap-6 border-b-2 border-neutral-800 pb-4">
        <div>
          <p className="text-xl font-bold">{hospital.legalName || 'Hospital legal name not set'}</p>
          {hospital.address && <p className="whitespace-pre-line text-neutral-600 print:text-black">{hospital.address}</p>}
          <p className="text-neutral-600 print:text-black">{hospital.gstin ? `GSTIN ${hospital.gstin}` : 'Not registered for GST'}</p>
          {hospital.stateCode && <p className="text-neutral-600 print:text-black">State: {placeLabel(hospital.stateCode)}</p>}
        </div>
        <div className="text-right">
          <h1 className="text-lg font-bold tracking-wide">{title}</h1>
          <dl className="mt-2 grid grid-cols-[auto_auto] justify-end gap-x-3 text-sm">
            <dt className="text-neutral-500 print:text-black">{draft ? 'Reference' : 'Invoice No.'}</dt>
            <dd className="font-semibold">{invoice.invoiceNumber ?? `Draft #${invoice.id}`}</dd>
            <dt className="text-neutral-500 print:text-black">Date</dt>
            <dd>{invoice.invoiceDate ? formatIsoDate(invoice.invoiceDate) : '—'}</dd>
            <dt className="text-neutral-500 print:text-black">Place of supply</dt>
            <dd>{placeLabel(place.stateCode)}</dd>
          </dl>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-6 border-b border-neutral-300 py-4">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 print:text-black">Bill to (patient)</h2>
          <p className="font-semibold">{parties.patient.name}</p>
          <p>UHID {parties.patient.uhid ?? '—'}</p>
          {addressLines(parties.patient).map((l) => <p key={l}>{l}</p>)}
        </div>
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 print:text-black">{parties.payer ? 'Payer' : 'Payment'}</h2>
          {parties.payer ? (
            <>
              <p className="font-semibold">{parties.payer.name}</p>
              <p>{parties.payer.gstin ? `GSTIN ${parties.payer.gstin}` : 'GSTIN not on file'}</p>
              {parties.payer.stateCode && <p>{stateName(parties.payer.stateCode)}</p>}
            </>
          ) : <p>Self-pay</p>}
          <p className="mt-1 text-neutral-600 print:text-black">{parties.context.label}</p>
        </div>
      </section>

      {draft && (
        <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900 print:bg-transparent print:px-0 print:text-black">
          This is an estimate. Tax is worked out from the current settings and fixed only when the invoice is finalised and numbered.
        </p>
      )}

      <table aria-label="Invoice lines" className="mt-4 w-full border-collapse text-[12px]">
        <thead>
          <tr>
            <th className={th}>#</th>
            <th className={th}>Item</th>
            <th className={th}>HSN/SAC</th>
            <th className={th}>Date</th>
            <th className={`${th} text-right`}>Qty</th>
            <th className={`${th} text-right`}>Rate</th>
            <th className={`${th} text-right`}>Taxable</th>
            {inter ? (
              <th className={`${th} text-right`}>IGST % / ₹</th>
            ) : (
              <>
                <th className={`${th} text-right`}>CGST % / ₹</th>
                <th className={`${th} text-right`}>SGST % / ₹</th>
              </>
            )}
            <th className={`${th} text-right`}>Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineNo} className="print:break-inside-avoid">
              <td className={td}>{l.lineNo}</td>
              <td className={td}>
                <span className="font-medium">{l.itemName}</span>
                <span className="block text-[11px] text-neutral-500 print:text-black">{l.itemCode}</span>
              </td>
              <td className={td}>{l.hsnSac}</td>
              <td className={`${td} whitespace-nowrap`}>{formatIsoDate(l.serviceDate)}</td>
              <td className={`${td} text-right tabular-nums`}>{l.quantity}</td>
              <td className={`${td} text-right tabular-nums`}>{formatPaise(l.unitPricePaise)}</td>
              <td className={`${td} text-right tabular-nums`}>{formatPaise(l.taxablePaise)}</td>
              {inter ? (
                <td className={`${td} text-right tabular-nums`}>{bpToPercent(l.igstRateBp)}<span className="block">{formatPaise(l.igstPaise)}</span></td>
              ) : (
                <>
                  <td className={`${td} text-right tabular-nums`}>{bpToPercent(l.cgstRateBp)}<span className="block">{formatPaise(l.cgstPaise)}</span></td>
                  <td className={`${td} text-right tabular-nums`}>{bpToPercent(l.sgstRateBp)}<span className="block">{formatPaise(l.sgstPaise)}</span></td>
                </>
              )}
              <td className={`${td} text-right font-medium tabular-nums`}>{formatPaise(l.totalPaise)}</td>
            </tr>
          ))}
          {lines.length === 0 && (
            <tr><td colSpan={inter ? 9 : 10} className={`${td} text-center text-neutral-500`}>No lines</td></tr>
          )}
        </tbody>
      </table>

      <section className="mt-4 flex justify-end print:break-inside-avoid">
        <dl className="grid w-72 grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          <dt>Taxable value</dt><dd className="text-right tabular-nums">{formatPaise(totals.taxable)}</dd>
          {inter ? (
            <><dt>IGST</dt><dd className="text-right tabular-nums">{formatPaise(totals.igst)}</dd></>
          ) : (
            <>
              <dt>CGST</dt><dd className="text-right tabular-nums">{formatPaise(totals.cgst)}</dd>
              <dt>SGST</dt><dd className="text-right tabular-nums">{formatPaise(totals.sgst)}</dd>
            </>
          )}
          <dt className="border-t-2 border-neutral-800 pt-1 text-base font-bold">Total</dt>
          <dd className="border-t-2 border-neutral-800 pt-1 text-right text-base font-bold tabular-nums">{formatPaise(totals.total)}</dd>
        </dl>
      </section>
      <p className="mt-2 text-right text-xs italic">{rupeesInWords(totals.total)}</p>

      <footer className="mt-10 flex items-end justify-between gap-6 text-xs text-neutral-500 print:text-black">
        <p>
          {draft ? 'Provisional bill. Not valid for input tax credit.' : 'Computer-generated document.'}
          {invoice.finalisedByName && <span className="block">Finalised by {invoice.finalisedByName}</span>}
        </p>
        <div className="text-right">
          <p>For {hospital.legalName || 'the hospital'}</p>
          <p className="mt-8 border-t border-neutral-400 pt-1">Authorised signatory</p>
        </div>
      </footer>
    </article>
  )
}
