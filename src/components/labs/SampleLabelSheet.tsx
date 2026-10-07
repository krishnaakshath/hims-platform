// SP5: printable sample labels (server component). The QR encodes the CANONICAL sample ID and is
// drawn as <svg> <rect>s from the module matrix -- no generated markup string, no innerHTML.
// A label carries only what the tube needs: sample ID, test, container, patient name and UHID.
import { qrModules } from '@/lib/labs/qr'
import { displaySampleId } from '@/lib/labs/sample-id'
import { SAMPLE_CONTAINER_LABEL, type SampleContainer } from '@/lib/labs/catalog'
import type { SampleLabelRow } from '@/lib/queries/lab-orders'

const QUIET_ZONE = 2

function SampleQr({ sampleId }: { sampleId: string }) {
  const { size, dark } = qrModules(sampleId)
  const extent = size + QUIET_ZONE * 2
  const cells: React.ReactNode[] = []
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (dark[r * size + c]) cells.push(<rect key={`${r}-${c}`} x={c + QUIET_ZONE} y={r + QUIET_ZONE} width={1} height={1} />)
    }
  }
  return (
    <svg
      data-testid="sample-qr"
      viewBox={`0 0 ${extent} ${extent}`}
      width={96}
      height={96}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`QR code for sample ${displaySampleId(sampleId)}`}
      className="shrink-0"
    >
      <rect x={0} y={0} width={extent} height={extent} fill="#fff" />
      <g fill="#000">{cells}</g>
    </svg>
  )
}

function containerLabel(container: string | null): string | null {
  if (container === null) return null
  return SAMPLE_CONTAINER_LABEL[container as SampleContainer] ?? null
}

// Print: only the sheet is printed (the dashboard chrome is hidden), one label per block.
const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  .lab-label-sheet, .lab-label-sheet * { visibility: visible !important; }
  .lab-label-sheet { position: absolute; left: 0; top: 0; width: 100%; }
  .lab-label { break-inside: avoid; page-break-inside: avoid; }
}
`

export function SampleLabelSheet({ labels }: { labels: SampleLabelRow[] }) {
  return (
    <>
      <style>{PRINT_CSS}</style>
      <div className="lab-label-sheet grid grid-cols-1 gap-3 sm:grid-cols-2">
        {labels.map((l) => {
          const container = containerLabel(l.container)
          return (
            <div key={l.orderId} className="lab-label flex items-center gap-3 rounded-md border border-border bg-white p-3 text-black">
              {l.sampleId ? <SampleQr sampleId={l.sampleId} /> : null}
              <div className="min-w-0 text-sm">
                {l.sampleId
                  ? <p className="font-mono text-base font-semibold">{displaySampleId(l.sampleId)}</p>
                  : <p className="font-semibold">No sample ID yet</p>}
                <p>{l.testName}</p>
                {container && <p className="text-xs">{container}</p>}
                <p className="text-xs">{l.patientName}{l.uhid ? ` · ${l.uhid}` : ''}</p>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
