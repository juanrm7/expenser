import { existsSync } from 'node:fs'
import { defineConfig } from 'drizzle-kit'

// The same database the server uses (see .env.example); `db:studio` opens it.
if (existsSync('.env')) process.loadEnvFile('.env')

// `pnpm db:generate` diffs src/db/schema.ts against the last snapshot in drizzle/meta and writes
// the next migration to drizzle/. The server applies pending migrations at startup.
export default defineConfig({
  dialect: 'turso',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL ?? 'file:./dev.db',
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
})
