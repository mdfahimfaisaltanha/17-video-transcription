import { Pool } from "pg"

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined
}

export function db(): Pool {
  if (!global.__pgPool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.")
    }
    global.__pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
    })
  }
  return global.__pgPool
}
