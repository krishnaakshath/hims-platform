import { BackLink } from '@/components/BackLink'
import { PrintButton } from '@/components/PrintButton'
import { brand } from '@/lib/brand'

// Wave C: the 80 mm thermal-printer slip shell shared by the OPD token slip
// and the registration slip. A NAMED @page ('slip') scopes the 80 mm paper
// size to these slips only -- the global @page in globals.css (A4 margins
// for the prescription print) is untouched. The on-screen controls are
// `.no-print`; printing is an explicit click (see PrintButton).
const SLIP_CSS = `
@page slip { size: 80mm auto; margin: 3mm; }
@media print {
  .slip-page { page: slip; width: 74mm; margin: 0; padding: 0; border: 0 !important; box-shadow: none !important; }
}
`

export function PrintSlip({ title, backHref, backLabel, children }: { title: string; backHref: string; backLabel: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-sm px-4 py-6 text-foreground">
      <style>{SLIP_CSS}</style>
      <div className="no-print mb-4 flex items-center justify-between gap-3">
        <BackLink href={backHref} label={backLabel} />
        <PrintButton />
      </div>
      <article aria-label={title} className="slip-page mx-auto w-[80mm] max-w-full rounded-md border border-border bg-white p-3 text-center font-sans text-black">
        <header className="border-b border-dashed border-black/40 pb-2">
          <p className="text-sm font-bold leading-tight">{brand.legalName}</p>
          <p className="text-[11px] uppercase tracking-wide">{title}</p>
        </header>
        {children}
      </article>
    </div>
  )
}

export function SlipRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-left text-xs">
      <span className="shrink-0 text-black/70">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  )
}
