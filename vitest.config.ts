import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // `.worktrees/` holds full nested checkouts of other branches (see
    // superpowers:using-git-worktrees) -- without excluding it, Vitest's
    // default file discovery also picks up every test file inside any
    // worktree, double-counting the whole suite and cross-resolving `@/*`
    // imports against the wrong copy of the source tree.
    exclude: ['**/node_modules/**', '**/.git/**', '**/.worktrees/**'],
    // Test files share one live, persistent Neon database (no per-test DB
    // isolation — see Task 4's review ruling). tests/db/seed.test.ts
    // destructively truncates and reseeds it, which races with any other
    // file reading real rows concurrently (e.g. tests/api/patients.test.ts).
    // Run files sequentially to keep the shared-state suite deterministic.
    fileParallelism: false,
    // The DB client now uses a real TCP connection pool (drizzle-orm/
    // node-postgres) instead of Neon's HTTP driver, so a test that makes
    // several sequential real round trips (insert, insert, update, insert,
    // select, select, several cleanup deletes) genuinely takes real network
    // time -- especially the very first test in a run, which also pays the
    // pool's cold TCP+TLS connect cost. Vitest's 5000ms default was tuned
    // for the old driver's behavior and clips real multi-query tests now.
    testTimeout: 15000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
