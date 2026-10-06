// Skeleton for the patients data table: title + trial-filter tab bar +
// export button toolbar, then the 7-column table (Status, Anon #, Name,
// DOB, Provider, Referral Type, Last Communication).
export default function PatientsLoading() {
  const columns = 7
  const rows = 8

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div className="h-7 w-28 animate-pulse rounded-md bg-muted" />
        <div className="flex items-center gap-4">
          <div className="flex gap-1 rounded-lg bg-secondary p-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-7 w-20 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
          <div className="h-9 w-56 animate-pulse rounded-md bg-muted" />
        </div>
      </div>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            {Array.from({ length: columns }).map((_, i) => (
              <th key={i} className="p-3">
                <div className="h-3 w-16 animate-pulse rounded bg-muted" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <tr key={rowIndex} className={`border-b border-border ${rowIndex % 2 === 1 ? 'bg-muted/40' : ''}`}>
              <td className="p-3">
                <div className="h-4 w-4 animate-pulse rounded-full bg-muted" />
              </td>
              <td className="p-3"><div className="h-4 w-10 animate-pulse rounded bg-muted" /></td>
              <td className="p-3"><div className="h-4 w-32 animate-pulse rounded bg-muted" /></td>
              <td className="p-3"><div className="h-4 w-20 animate-pulse rounded bg-muted" /></td>
              <td className="p-3"><div className="h-4 w-28 animate-pulse rounded bg-muted" /></td>
              <td className="p-3"><div className="h-4 w-24 animate-pulse rounded bg-muted" /></td>
              <td className="p-3"><div className="h-4 w-28 animate-pulse rounded bg-muted" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 h-3 w-24 animate-pulse rounded bg-muted" />
    </div>
  )
}
