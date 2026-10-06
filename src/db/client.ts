import net from 'net'
import { lookup } from 'dns'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'

// TCP (node-postgres), not Neon's HTTP driver -- the HTTP driver issues
// every query as an HTTPS fetch to Neon's data-plane endpoint, and this
// project's dev/CI sandbox has a real, sustained outbound-HTTPS reliability
// problem to that endpoint (confirmed repeatedly: raw TCP on port 5432 --
// what `psql` and this same connection string use -- always connects, while
// the HTTP driver's port-443 fetches intermittently or persistently fail
// with ETIMEDOUT/EHOSTUNREACH). A real TCP connection pool sidesteps that
// entire failure class. As a side effect, this also unlocks real
// multi-statement transactions, which the HTTP driver never supported --
// several call sites elsewhere in this codebase carry comments explaining
// why they run sequential statements instead of a transaction for exactly
// that reason; revisiting those is a separate, later improvement, not part
// of this driver swap.
//
// Neon's pooler hostname resolves to both IPv4 and IPv6 addresses, and this
// sandbox's IPv6 egress is dead (confirmed directly: "No route to host" on
// every IPv6 address, instant success on every IPv4 one). `pg` has no
// config option to prefer a DNS family -- its Connection class calls the
// plain two-argument `socket.connect(port, host)`, which can't carry a
// custom `lookup` function. A custom `stream` factory can, though: pg calls
// it fresh per pooled connection (`typeof config.stream === 'function'`),
// so this intercepts just the DNS step and resolves to IPv4 itself before
// handing off to the real `net.Socket.prototype.connect`.
//
// Crucially, this passes the ORIGINAL hostname through to pg's TLS upgrade
// (`Connection#upgradeToSSL`), not the resolved IP -- that function sets
// SNI's `servername` from the `host` argument `Connection#connect(port,
// host)` was called with, which never changes here, only what the
// underlying socket actually dials. Neon's pooler is a multi-tenant TLS
// proxy that routes by SNI, so substituting a bare IP for `host` instead
// would risk connecting to the wrong backend entirely, not just breaking
// certificate validation.
function createIPv4PreferringStream(): net.Socket {
  const socket = new net.Socket()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkey-patching a socket method with a signature TS can't express cleanly across net.Socket#connect's overloads
  const nativeConnect: any = net.Socket.prototype.connect
  socket.connect = ((port: number, host?: string, connectListener?: () => void) => {
    if (typeof host !== 'string' || net.isIP(host) !== 0) {
      return nativeConnect.call(socket, port, host, connectListener)
    }
    lookup(host, { family: 4 }, (err, address) => {
      if (err) { socket.emit('error', err); return }
      nativeConnect.call(socket, port, address, connectListener)
    })
    return socket
  }) as typeof socket.connect
  return socket
}

function createDb() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    ssl: { rejectUnauthorized: false },
    stream: createIPv4PreferringStream,
    // Fail fast instead of hanging forever when the pool is exhausted or
    // Neon is unreachable, and recycle idle clients before Neon resets them.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  })
  // An idle client whose connection Neon resets emits 'error' on the pool;
  // with no listener Node treats it as unhandled and terminates the process.
  // pg discards the dead client itself, so logging is all that is needed.
  // Message only: the raw error can carry the connection string or query text.
  pool.on('error', (err) => {
    console.error(`[db] idle pool client error (${err.name}${(err as NodeJS.ErrnoException).code ? `: ${(err as NodeJS.ErrnoException).code}` : ''})`)
  })
  return drizzle(pool, { schema })
}

let _db: ReturnType<typeof createDb> | null = null

export function getDb() {
  if (!_db) _db = createDb()
  return _db
}
