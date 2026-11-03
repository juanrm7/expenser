// The database schema. Tables and columns are named as the original (Prisma) backend created them:
// PascalCase tables, camelCase columns, the same constraint and index names. Change it here, then run
// `pnpm db:generate` to write the migration (see drizzle.config.ts).

import { sql } from 'drizzle-orm'
import {
  customType,
  foreignKey,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/**
 * Encodes an instant for storage: UTC text in the fixed-width format the Prisma backend wrote,
 * `2026-10-12T03:00:00.000+00:00`, so comparing timestamps as strings orders them.
 */
export function encodeTimestamp(instant: Date): string {
  return instant.toISOString().replace(/Z$/, '+00:00')
}

/** Decodes a stored instant, including SQLite's `CURRENT_TIMESTAMP` format (UTC, no zone). */
export function decodeTimestamp(value: string): Date {
  const currentTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
  return new Date(currentTimestamp ? `${value.replace(' ', 'T')}Z` : value)
}

/** An instant: a `Date` in TypeScript, see `encodeTimestamp` in the database. */
const timestamp = customType<{ data: Date; driverData: string }>({
  dataType: () => 'DATETIME',
  toDriver: encodeTimestamp,
  fromDriver: decodeTimestamp,
})

export const users = sqliteTable(
  'User',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    email: text().notNull(),
    passwordHash: text().notNull(),
    expendableAmountPerWeek: real().notNull(),
    role: text().notNull().default('user'),
    createdAt: timestamp().notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp().notNull(),
  },
  (t) => [uniqueIndex('User_email_key').on(t.email)],
)

export const sessions = sqliteTable(
  'Session',
  {
    id: text().primaryKey(),
    userId: integer().notNull(),
    expiresAt: timestamp().notNull(),
    createdAt: timestamp().notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    foreignKey({ name: 'Session_userId_fkey', columns: [t.userId], foreignColumns: [users.id] })
      .onDelete('cascade')
      .onUpdate('cascade'),
    index('Session_userId_idx').on(t.userId),
  ],
)

export const categories = sqliteTable(
  'Category',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    color: text().notNull(),
    userId: integer().notNull(),
  },
  (t) => [
    foreignKey({ name: 'Category_userId_fkey', columns: [t.userId], foreignColumns: [users.id] })
      .onDelete('cascade')
      .onUpdate('cascade'),
    index('Category_userId_idx').on(t.userId),
  ],
)

export const expenses = sqliteTable(
  'Expense',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    description: text().notNull(),
    amount: real().notNull(),
    /** The category's name when it was set: not a reference, so it survives the category. */
    category: text().notNull(),
    /** When the expense happened: when it was added, or the start of the local day it's dated. */
    createdAt: timestamp().notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp().notNull(),
    userId: integer().notNull(),
  },
  (t) => [
    foreignKey({ name: 'Expense_userId_fkey', columns: [t.userId], foreignColumns: [users.id] })
      .onDelete('cascade')
      .onUpdate('cascade'),
    index('Expense_userId_idx').on(t.userId),
  ],
)

export const apiKeys = sqliteTable(
  'ApiKey',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    /** The key's first characters, shown in the UI to tell keys apart. */
    prefix: text().notNull(),
    /** SHA-256 of the full key (see lib/tokens.ts); the key itself is never stored. */
    keyHash: text().notNull(),
    lastUsedAt: timestamp(),
    createdAt: timestamp().notNull().default(sql`CURRENT_TIMESTAMP`),
    userId: integer().notNull(),
  },
  (t) => [
    foreignKey({ name: 'ApiKey_userId_fkey', columns: [t.userId], foreignColumns: [users.id] })
      .onDelete('cascade')
      .onUpdate('cascade'),
    uniqueIndex('ApiKey_keyHash_key').on(t.keyHash),
    index('ApiKey_userId_idx').on(t.userId),
  ],
)

/** An app that registered itself for OAuth (RFC 7591), e.g. Claude. Every client is public. */
export const oauthClients = sqliteTable('OAuthClient', {
  id: text().primaryKey(),
  name: text().notNull(),
  /** A JSON array of the URIs codes may be sent to. */
  redirectUris: text().notNull(),
  createdAt: timestamp().notNull(),
})

/** A short-lived, single-use authorization code. */
export const oauthCodes = sqliteTable(
  'OAuthCode',
  {
    codeHash: text().primaryKey(),
    clientId: text().notNull(),
    userId: integer().notNull(),
    redirectUri: text().notNull(),
    /** PKCE: base64url(SHA-256(code_verifier)). */
    codeChallenge: text().notNull(),
    expiresAt: timestamp().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'OAuthCode_clientId_fkey',
      columns: [t.clientId],
      foreignColumns: [oauthClients.id],
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    foreignKey({ name: 'OAuthCode_userId_fkey', columns: [t.userId], foreignColumns: [users.id] })
      .onDelete('cascade')
      .onUpdate('cascade'),
  ],
)

/** One user's connection to one client, holding the hashes of its current tokens. */
export const oauthGrants = sqliteTable(
  'OAuthGrant',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    clientId: text().notNull(),
    userId: integer().notNull(),
    accessTokenHash: text().notNull(),
    accessExpiresAt: timestamp().notNull(),
    refreshTokenHash: text().notNull(),
    refreshExpiresAt: timestamp().notNull(),
    lastUsedAt: timestamp(),
    createdAt: timestamp().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'OAuthGrant_clientId_fkey',
      columns: [t.clientId],
      foreignColumns: [oauthClients.id],
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    foreignKey({ name: 'OAuthGrant_userId_fkey', columns: [t.userId], foreignColumns: [users.id] })
      .onDelete('cascade')
      .onUpdate('cascade'),
    uniqueIndex('OAuthGrant_accessTokenHash_key').on(t.accessTokenHash),
    uniqueIndex('OAuthGrant_refreshTokenHash_key').on(t.refreshTokenHash),
    index('OAuthGrant_userId_idx').on(t.userId),
  ],
)
