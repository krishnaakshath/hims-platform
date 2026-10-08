import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
  // The migration ledger (scripts/db/migrate.ts) is not in schema.ts; without
  // this, a local `db:push` would offer to drop it. db:push is for throwaway
  // local databases only; every real database is managed by `npm run db:migrate`.
  tablesFilter: ['!schema_migrations'],
})
