// Per-user API keys for scripts: `Authorization: Bearer exp_…`.
//
// Only a hash of each key is stored (see lib/tokens.ts); the key itself is returned once, on creation.

import { and, count, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Context } from '../../context.js'
import { one } from '../../db/index.js'
import { apiKeys, users } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import { generateToken, hashToken } from '../../lib/tokens.js'
import { toUser, userColumns, type User } from '../auth/auth.service.js'

const KEY_PREFIX = 'exp_'
/** "exp_" plus 8 characters: enough to tell keys apart in the UI. */
const DISPLAY_PREFIX_LENGTH = 12
const MAX_NAME_LENGTH = 50
const MAX_KEYS_PER_USER = 10
/** `lastUsedAt` is written at most this often per key. */
export const LAST_USED_RESOLUTION_MS = 60 * 1000

const apiKeyColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  lastUsedAt: apiKeys.lastUsedAt,
  createdAt: apiKeys.createdAt,
}

export function listApiKeys(ctx: Context, userId: number) {
  return ctx.db
    .select(apiKeyColumns)
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
}

export const createApiKeyBody = z.object({ name: z.string().nullish() })

/** Creates a key, returning it with the full key: the only time it's ever available. */
export async function createApiKey(ctx: Context, userId: number, body: z.output<typeof createApiKeyBody>) {
  const name = body.name?.trim() ?? ''
  if (!name) throw AppError.badRequest('Name is required')
  if (Array.from(name).length > MAX_NAME_LENGTH) {
    throw AppError.badRequest(`Name must be at most ${MAX_NAME_LENGTH} characters`)
  }

  const { keys } = one(await ctx.db.select({ keys: count() }).from(apiKeys).where(eq(apiKeys.userId, userId)))
  if (keys >= MAX_KEYS_PER_USER) {
    throw AppError.badRequest(`You can have at most ${MAX_KEYS_PER_USER} API keys`)
  }

  const key = generateToken(KEY_PREFIX)
  const apiKey = one(
    await ctx.db
      .insert(apiKeys)
      .values({
        name,
        prefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
        keyHash: hashToken(key),
        createdAt: ctx.now(),
        userId,
      })
      .returning(apiKeyColumns),
  )
  return { ...apiKey, key }
}

export async function revokeApiKey(ctx: Context, userId: number, id: number): Promise<void> {
  const deleted = await ctx.db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
    .returning({ id: apiKeys.id })
  if (deleted.length === 0) throw AppError.notFound('API key not found')
}

/** The owner of a raw API key, or null if the key is unknown or revoked. */
export async function apiKeyUser(ctx: Context, key: string): Promise<User | null> {
  if (!key.startsWith(KEY_PREFIX)) return null
  const [owner] = await ctx.db
    .select({ ...userColumns, keyId: apiKeys.id, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.keyHash, hashToken(key)))
  if (!owner) return null

  const now = ctx.now()
  if (!owner.lastUsedAt || now.getTime() - owner.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await ctx.db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, owner.keyId))
  }
  return toUser(owner)
}
