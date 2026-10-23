import type { NextConfig } from "next";

// Baseline security headers -- flagged as entirely missing by both security
// audits. HSTS only matters in production (over HTTP in dev it's a no-op,
// but sending it there is still harmless).
const nextConfig: NextConfig = {
  // nodemailer isn't on Next's short list of packages auto-opted-out of
  // Server Components bundling (see serverExternalPackages docs) -- without
  // this, Turbopack tries to bundle it for the server graph and fails with
  // "Module not found: Can't resolve 'nodemailer'" even though it's
  // correctly installed, since nodemailer's own use of Node-specific
  // features (TLS/DNS internals in its SMTP transport) isn't bundler-safe.
  serverExternalPackages: ['nodemailer'],
  // GET /api/health compares the migration ledger with the files in
  // scripts/migrations (src/lib/config-check.ts); ship their names with it.
  outputFileTracingIncludes: {
    '/api/health': ['./scripts/migrations/*.sql'],
    '/api/health/ready': ['./scripts/migrations/*.sql'],
  },
  experimental: {
    // Dev only: Next's Server Components HMR fetch cache survives
    // router.refresh(), so a status-changing action looked like it did
    // nothing until a hard reload. Off, every refresh shows the new state.
    serverComponentsHmrCache: false,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
};

export default nextConfig;
