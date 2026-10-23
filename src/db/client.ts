import net from 'net'
import { lookup } from 'dns'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import { sslFor } from './url'
import { ServiceNotConfiguredError } from '@/lib/service-config'

// TCP connection pool (node-postgres). In Docker the database is the compose
// `postgres` service (no TLS, see src/db/url.ts).
//
// Some networks this runs on have dead IPv6 egress while DNS still returns
// AAAA records. `pg` has no option to prefer a DNS family, but it calls a
// custom `stream` factory per pooled connection, so this resolves the host to
// IPv4 itself before dialing. The ORIGINAL hostname still reaches pg's TLS
// upgrade (SNI is set from the host pg was given), so certificate checks and
// SNI routing are unaffected. IP literals and the in-network service name
// resolve as usual.
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
    // No TLS for a local database, TLS for every hosted one (src/db/url.ts).
    ssl: sslFor(process.env.DATABASE_URL),
    stream: createIPv4PreferringStream,
    // Fail fast instead of hanging forever when the pool is exhausted or
    // the database is unreachable, and recycle idle clients.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  })
  // An idle client whose connection the server resets emits 'error' on the pool;
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
  // Without this, pg silently falls back to localhost:5432 and every query
  // fails with a connection error that does not say what is wrong.
  if (!process.env.DATABASE_URL) throw new ServiceNotConfiguredError('database')
  if (!_db) _db = createDb()
  return _db
}
