import { BackLink } from '@/components/BackLink'
import { PrintButton } from '@/components/PrintButton'
import { brand } from '@/lib/brand'
import { formatIstDateTime } from '@/lib/india-time'

// Wave F: the A4 shell for clinical documents (prescription slip, discharge
// summary). Server-rendered, no client state: the document reads and prints
// without JavaScript (the Print button is the only client island and is an
// explicit click). A NAMED @page ('a4doc') scopes the A4 paper size to these
// documents; the global @page margin in globals.css and the 80 mm slip page
// (PrintSlip) are untouched. On-screen controls are `.no-print`.
const A4_CSS = `
@page a4doc { size: A4; margin: 14mm 14mm 16mm; }
@media print {
  .a4-doc { page: a4doc; width: auto; max-width: none; margin: 0; padding: 0; border: 0 !important; box-shadow: none !important; }
  .a4-doc section, .a4-doc tr { break-inside: avoid; }
  .a4-screen { background: #fff !important; padding: 0 !important; }
}
`

export interface PrintDocumentProps {
  /** Document title, e.g. "Discharge summary". Rendered as the page h1. */
  title: string
  backHref: string
  backLabel: string
  /** Hospital display name; defaults to the brand's legal name. */
  hospitalName?: string | null
  /** A second header line (site / address). */
  hospitalSubline?: string | null
  /** Right-hand header facts (document number, dates). */
  meta?: { label: string; value: string }[]
  printedAt: Date
  children: React.ReactNode
}

export function PrintDocument({ title, backHref, backLabel, hospitalName, hospitalSubline, meta = [], printedAt, children }: PrintDocumentProps) {
  return (
    <main className="a4-screen min-h-screen bg-neutral-100 px-4 py-8 text-neutral-900">
      <style>{A4_CSS}</style>
      <div className="no-print mx-auto mb-4 flex max-w-[210mm] items-center justify-between gap-3">
        <BackLink href={backHref} label={backLabel} />
        <PrintButton />
      </div>
      <article aria-label={title} className="a4-doc mx-auto w-full max-w-[210mm] bg-white p-10 text-[13px] leading-relaxed text-black shadow-sm ring-1 ring-neutral-200">
        <header className="flex items-start justify-between gap-6 border-b-2 border-neutral-800 pb-3">
          <div className="flex items-start gap-3">
            {brand.logoUrl && (
              // A validated https:// or /-relative URL (src/lib/brand.ts); a plain img prints reliably.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brand.logoUrl} alt="" className="h-12 w-auto" />
            )}
            <div>
              <p className="text-xl font-bold leading-tight">{hospitalName || brand.legalName}</p>
              {hospitalSubline && <p className="text-xs text-neutral-700">{hospitalSubline}</p>}
            </div>
          </div>
          <div className="text-right">
            <h1 className="text-lg font-bold uppercase tracking-wide">{title}</h1>
            {meta.length > 0 && (
              <dl className="mt-1 grid grid-cols-[auto_auto] justify-end gap-x-3 text-xs">
                {meta.map((m) => (
                  <div key={m.label} className="contents">
                    <dt className="text-neutral-600">{m.label}</dt>
                    <dd className="font-medium">{m.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </header>
        {children}
        <footer className="mt-8 border-t border-neutral-300 pt-2 text-[10px] text-neutral-600">
          Computer-generated document from {brand.name}. Printed {formatIstDateTime(printedAt, { label: true })}.
        </footer>
      </article>
    </main>
  )
}

/** A label/value pair inside a document's patient or admission grid. */
export function DocField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-neutral-600">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  )
}

/** A titled document section. */
export function DocSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="mb-1.5 border-b border-neutral-300 pb-0.5 text-xs font-bold uppercase tracking-wide text-neutral-800">{title}</h2>
      {children}
    </section>
  )
}
