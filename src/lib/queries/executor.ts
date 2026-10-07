import type { getDb } from '@/db/client'

// The shared db or a transaction handle (`getDb().transaction((tx) => …)`), so a
// query helper can run inside its caller's transaction.
export type WriteExecutor = Pick<ReturnType<typeof getDb>, 'execute' | 'select' | 'insert' | 'update' | 'delete'>
