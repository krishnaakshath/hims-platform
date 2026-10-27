'use client'
import { useRouter } from 'next/navigation'

// Opens an empty editor at /forms/new. Nothing is created here: the template
// row is written only when the first edit is made there (spec D11), so an
// abandoned "Create New Form" click leaves no stray "Untitled Form".
export function CreateFormButton({ folderId }: { folderId: number | null }) {
  const router = useRouter()
  return (
    <button
      onClick={() => router.push(folderId === null ? '/forms/new' : `/forms/new?folderId=${folderId}`)}
      className="rounded-lg border-2 border-dashed border-border p-5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
    >
      + Create New Form
    </button>
  )
}
