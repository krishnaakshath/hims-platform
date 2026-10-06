import Link from 'next/link'
import { Folder } from 'lucide-react'

export function FolderCard({ folder }: { folder: { id: number; name: string; activeTemplateCount: number } }) {
  return (
    <Link href={`/forms/folders/${folder.id}`} className="group block rounded-xl border border-primary/10 border-l-2 border-l-transparent bg-card/80 p-5 shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-l-primary hover:bg-primary/5 hover:shadow-md">
      <div className="mb-2 flex items-center gap-2">
        <Folder className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="font-semibold text-foreground group-hover:text-primary">{folder.name}</span>
      </div>
      <p className="text-sm text-muted-foreground">
        {folder.activeTemplateCount} form{folder.activeTemplateCount === 1 ? '' : 's'}
      </p>
    </Link>
  )
}
