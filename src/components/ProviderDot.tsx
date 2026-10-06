const PROVIDER_DOT_CLASSNAME: Record<string, string> = {
  'chart-1': 'bg-chart-1',
  'chart-2': 'bg-chart-2',
  'chart-3': 'bg-chart-3',
  'chart-4': 'bg-chart-4',
  'chart-5': 'bg-chart-5',
}

export function ProviderDot({ colorTag }: { colorTag: string }) {
  return <span className={`h-2 w-2 shrink-0 rounded-full ${PROVIDER_DOT_CLASSNAME[colorTag] ?? 'bg-muted-foreground'}`} aria-hidden="true" />
}
