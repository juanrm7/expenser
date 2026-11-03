// Accounts and sessions.

import { randomUUID } from 'node:crypto'
import bcrypt from 'bcrypt'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Context } from '../../context.js'
import { one } from '../../db/index.js'
import { categories, sessions, users } from '../../db/schema.js'
import { AppError, given } from '../../lib/errors.js'

export const SESSION_COOKIE = 'session_id'
export const SESSION_DAYS = 30
const BCRYPT_COST = 10
const MIN_PASSWORD_LENGTH = 8
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Every new account starts with these categories. */
const STARTER_CATEGORIES = [
  { name: 'Food', color: '#f97316' },
  { name: 'Transport', color: '#3b82f6' },
  { name: 'Entertainment', color: '#a855f7' },
  { name: 'Bills', color: '#ef4444' },
  { name: 'Other', color: '#6b7280' },
]

export type Role = 'user' | 'admin'

/** The authenticated user, as returned by `/auth/me`. */
export interface User {
  id: number
  name: string
  email: string
  expendableAmountPerWeek: number
  role: Role
}

/** The columns of a `User`, for queries that select or join it. */
export const userColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  expendableAmountPerWeek: users.expendableAmountPerWeek,
  role: users.role,
}

export function toUser(row: Omit<User, 'role'> & { role: string }): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    expendableAmountPerWeek: row.expendableAmountPerWeek,
    role: row.role === 'admin' ? 'admin' : 'user',
  }
}

export const signupBody = z.object({
  name: z.string().nullish(),
  email: z.string().nullish(),
  password: z.string().nullish(),
  expendableAmountPerWeek: z.number().nullish(),
})

/** Creates an account with the starter categories. */
export async function signup(ctx: Context, body: z.output<typeof signupBody>): Promise<User> {
  const name = body.name?.trim() ?? ''
  const email = normalizeEmail(body.email ?? '')
  const password = body.password ?? ''
  const allowance = body.expendableAmountPerWeek

  if (!name) throw AppError.badRequest('Name is required')
  if (!EMAIL_REGEX.test(email)) throw AppError.badRequest('Invalid email')
  if (Array.from(password).length < MIN_PASSWORD_LENGTH) {
    throw AppError.badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  if (allowance == null || !isValidAllowance(allowance)) {
    throw AppError.badRequest('Invalid expendable amount')
  }

  const [taken] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email))
  if (taken) throw new AppError(409, 'Email already in use')

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST)
  const now = ctx.now()
  const user = await ctx.db.transaction(async (tx) => {
    const user = one(
      await tx
        .insert(users)
        .values({ name, email, passwordHash, expendableAmountPerWeek: allowance, createdAt: now, updatedAt: now })
        .returning(userColumns),
    )
    await tx.insert(categories).values(STARTER_CATEGORIES.map((category) => ({ ...category, userId: user.id })))
    return user
  })
  return toUser(user)
}

export const loginBody = z.object({
  email: z.string().nullish(),
  password: z.string().nullish(),
})

/** The user with these credentials. */
export async function login(ctx: Context, body: z.output<typeof loginBody>): Promise<User> {
  const email = normalizeEmail(body.email ?? '')
  const password = body.password ?? ''
  if (!email || !password) throw AppError.badRequest('Email and password are required')

  const invalid = new AppError(401, 'Invalid credentials')
  const [user] = await ctx.db
    .select({ ...userColumns, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
  if (!user) throw invalid
  if (!(await bcrypt.compare(password, user.passwordHash))) throw invalid
  return toUser(user)
}

/** Starts a session for the user, returning its id. */
export async function startSession(ctx: Context, userId: number): Promise<string> {
  const id = randomUUID()
  const now = ctx.now()
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000)
  await ctx.db.insert(sessions).values({ id, userId, expiresAt, createdAt: now })
  return id
}

export async function endSession(ctx: Context, sessionId: string): Promise<void> {
  await ctx.db.delete(sessions).where(eq(sessions.id, sessionId))
}

/** The user of a current session. An expired session is deleted. */
export async function sessionUser(ctx: Context, sessionId: string): Promise<User | null> {
  const [session] = await ctx.db
    .select({ ...userColumns, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId))
  if (!session) return null
  if (session.expiresAt.getTime() <= ctx.now().getTime()) {
    await endSession(ctx, sessionId)
    return null
  }
  return toUser(session)
}

export const updateProfileBody = z.object({
  name: z.string().nullish(),
  expendableAmountPerWeek: z.number().nullish(),
})

/** Changes the user's name or weekly allowance; omitted fields keep their value. */
export async function updateProfile(
  ctx: Context,
  user: User,
  body: z.output<typeof updateProfileBody>,
): Promise<User> {
  const name = given(body.name)?.trim()
  const allowance = given(body.expendableAmountPerWeek)
  if (name === '') throw AppError.badRequest('Name cannot be empty')
  if (allowance !== undefined && !isValidAllowance(allowance)) {
    throw AppError.badRequest('Invalid expendable amount')
  }

  const updated = one(
    await ctx.db
      .update(users)
      .set({ name, expendableAmountPerWeek: allowance, updatedAt: ctx.now() })
      .where(eq(users.id, user.id))
      .returning(userColumns),
  )
  return toUser(updated)
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function isValidAllowance(amount: number): boolean {
  return Number.isFinite(amount) && amount >= 0
}
