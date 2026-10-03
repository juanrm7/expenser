import { createHash, randomBytes } from 'node:crypto'
import prisma from '../../lib/prisma.js'
import { toSessionUser } from '../auth/auth.service.js'
import type { SessionUser } from '../auth/auth.types.js'
import { ApiKeyError, type ApiKeySummary, type CreatedApiKey } from './api-keys.types.js'

const KEY_PREFIX = 'exp_'
const DISPLAY_PREFIX_LENGTH = 12 // "exp_" + 8 chars, enough to tell keys apart in the UI
const MAX_NAME_LENGTH = 50
const MAX_KEYS_PER_USER = 10
const LAST_USED_RESOLUTION_MS = 60 * 1000 // don't write lastUsedAt more than once a minute per key

const summarySelect = { id: true, name: true, prefix: true, lastUsedAt: true, createdAt: true } as const

// Keys are 256 bits of randomness, so a fast hash is enough (no bcrypt needed) and it lets us
// look a key up directly by its hash.
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export class ApiKeysService {
  getAll(userId: number): Promise<ApiKeySummary[]> {
    return prisma.apiKey.findMany({
      where: { userId },
      select: summarySelect,
      orderBy: { createdAt: 'desc' },
    })
  }

  async create(userId: number, data: { name?: string }): Promise<CreatedApiKey> {
    const name = data?.name?.trim()
    if (!name) throw new ApiKeyError(400, 'Name is required')
    if (name.length > MAX_NAME_LENGTH)
      throw new ApiKeyError(400, `Name must be at most ${MAX_NAME_LENGTH} characters`)

    const count = await prisma.apiKey.count({ where: { userId } })
    if (count >= MAX_KEYS_PER_USER)
      throw new ApiKeyError(400, `You can have at most ${MAX_KEYS_PER_USER} API keys`)

    const key = KEY_PREFIX + randomBytes(32).toString('base64url')
    const created = await prisma.apiKey.create({
      data: { name, prefix: key.slice(0, DISPLAY_PREFIX_LENGTH), keyHash: hashKey(key), userId },
      select: summarySelect,
    })
    return { ...created, key }
  }

  async delete(userId: number, id: number): Promise<boolean> {
    const result = await prisma.apiKey.deleteMany({ where: { id, userId } })
    return result.count > 0
  }

  /** Resolves a raw key from an Authorization header to its owner, or null if unknown/revoked. */
  async authenticate(key: string): Promise<SessionUser | null> {
    if (!key.startsWith(KEY_PREFIX)) return null

    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash: hashKey(key) },
      include: { user: true },
    })
    if (!apiKey) return null

    const lastUsed = apiKey.lastUsedAt?.getTime() ?? 0
    if (Date.now() - lastUsed > LAST_USED_RESOLUTION_MS) {
      await prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    }

    return toSessionUser(apiKey.user)
  }
}
