import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'

// Runtime connection goes through the libSQL driver adapter.
// - Production (Turso): TURSO_DATABASE_URL=libsql://... + TURSO_AUTH_TOKEN
// - Local dev: falls back to the same SQLite file the Prisma CLI uses.
const url = process.env.TURSO_DATABASE_URL ?? 'file:./prisma/dev.db'
const authToken = process.env.TURSO_AUTH_TOKEN

const adapter = new PrismaLibSQL({ url, authToken })
const prisma = new PrismaClient({ adapter })

export default prisma
