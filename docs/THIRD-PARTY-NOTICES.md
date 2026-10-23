# Third-party notices

Dependencies whose licence carries obligations beyond the usual permissive
npm terms, or that ship assets (fonts, images) inside the built app. The full
dependency list and versions are in `package.json` / `package-lock.json`.

## Geist and Geist Mono fonts

- Package: [`geist`](https://www.npmjs.com/package/geist) **1.7.2** (pinned
  exactly; published 2026-06-01).
- Used by: `src/app/layout.tsx` (`geist/font/sans`, `geist/font/mono`), which
  load the bundled `.woff2` files through `next/font/local`. The fonts are
  copied into the build output (`.next/static/media`); nothing is fetched from
  a font CDN at build or run time.
- Licence: SIL Open Font License 1.1. Copyright (c) 2023 Vercel, in
  collaboration with basement.studio. The licence text ships in
  `node_modules/geist/LICENSE.txt`. The OFL allows bundling and
  redistribution with software; the fonts may not be sold on their own, and
  a modified version may not use the reserved font name.
- Replaces: `next/font/google` (Geist, Geist_Mono), which downloaded the fonts
  from Google Fonts during `next build`.

## Container images (not npm dependencies)

`docker-compose.yml` runs these images as published: `postgres:15-alpine`
(PostgreSQL License), `redis:7-alpine`, `node:22-alpine` (MIT for Node.js) and
`hiett/serverless-redis-http` (MIT).

`redis:7-alpine` currently resolves to Redis 7.4.x, which is dual-licensed
RSALv2 / SSPLv1 (Redis 7.2 and earlier were BSD-3-Clause). Running it as an
internal component of this product is within those terms; offering Redis
itself as a service is not. If the owner wants a BSD-licensed cache, pin
`redis:7.2-alpine` or switch to `valkey/valkey` (BSD-3-Clause, protocol
compatible); neither change was made or tested here.

The app image adds Alpine packages `postgresql17-client`, `unzip` and
`tini`.
