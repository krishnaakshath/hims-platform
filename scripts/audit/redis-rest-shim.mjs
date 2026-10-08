// Local-only HTTP shim in front of the docker-compose Redis REST endpoint
// (serverless-redis-http). @upstash/ratelimit's Lua scripts start with
// `#!lua flags=allow-key-locking`, a flag only Upstash's own Redis accepts;
// stock Redis 7 rejects the script, so every rate-limited route (staff and
// patient sign-in, OTP, booking) answers 500 against the local stack. This
// shim rewrites that shebang to a plain `#!lua` and forwards everything else
// unchanged, so the app can be signed into locally.
//
//   node scripts/audit/redis-rest-shim.mjs   (listens on 8078, forwards to 8079)
//   KV_REST_API_URL=http://127.0.0.1:8078
//
// Never point a deployment at this; it is for local runs only.
import http from 'node:http'

const LISTEN = Number(process.env.SHIM_PORT ?? 8078)
const TARGET = new URL(process.env.SHIM_TARGET ?? 'http://127.0.0.1:8079')
const FLAG = /^#!lua flags=allow-key-locking/

function rewrite(value) {
  if (typeof value === 'string') return FLAG.test(value) ? value.replace(FLAG, '#!lua') : value
  if (Array.isArray(value)) return value.map(rewrite)
  return value
}

http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let body = Buffer.concat(chunks)
    if (body.length > 0 && (req.headers['content-type'] ?? '').includes('json')) {
      try { body = Buffer.from(JSON.stringify(rewrite(JSON.parse(body.toString('utf8'))))) } catch { /* forward as is */ }
    }
    const headers = { ...req.headers, host: TARGET.host, 'content-length': String(body.length) }
    const up = http.request({ hostname: TARGET.hostname, port: TARGET.port, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', () => { res.writeHead(502); res.end() })
    up.end(body)
  })
}).listen(LISTEN, '127.0.0.1', () => console.log(`redis-rest-shim on ${LISTEN} -> ${TARGET.href}`))
