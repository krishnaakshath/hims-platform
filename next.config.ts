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
  experimental: {
    // Neon's HTTP driver (@neondatabase/serverless via drizzle-orm/neon-http)
    // issues its queries as `fetch()` calls under the hood. Next's dev-only
    // Server Components HMR fetch cache (on by default) was caching those
    // query responses across `router.refresh()` calls -- which explicitly
    // do NOT bust it (only a full navigation/reload does) -- so every
    // status-changing action across the app (charge approvals, "Mark
    // Processed", etc.) appeared to silently do nothing until a hard
    // reload, even though the mutation succeeded server-side. Disabling it
    // trades a little dev-server query traffic for actions actually
    // showing their effect immediately, which matters a lot live in a demo.
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
