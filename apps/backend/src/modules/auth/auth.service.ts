import { randomUUID } from 'node:crypto'
import bcrypt from 'bcrypt'
import prisma from '../../lib/prisma.js'
import {
  AuthError,
  type AuthResult,
  type LoginRequest,
  type Role,
  type SessionUser,
  type SignupRequest,
  type UpdateProfileRequest,
} from './auth.types.js'

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const BCRYPT_COST = 10
const MIN_PASSWORD_LENGTH = 8
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const STARTER_CATEGORIES: Array<{ name: string; color: string }> = [
  { name: 'Food', color: '#f97316' },
  { name: 'Transport', color: '#3b82f6' },
  { name: 'Entertainment', color: '#a855f7' },
  { name: 'Bills', color: '#ef4444' },
  { name: 'Other', color: '#6b7280' },
]

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function toSessionUser(user: {
  id: number
  name: string
  email: string
  expendableAmountPerWeek: number
  role: string
}): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    expendableAmountPerWeek: user.expendableAmountPerWeek,
    role: (user.role === 'admin' ? 'admin' : 'user') as Role,
  }
}

export class AuthService {
  async signup(data: SignupRequest): Promise<AuthResult> {
    const name = data.name?.trim()
    const email = data.email ? normalizeEmail(data.email) : ''
    const password = data.password ?? ''
    const expendableAmountPerWeek = Number(data.expendableAmountPerWeek)

    if (!name) throw new AuthError(400, 'Name is required')
    if (!EMAIL_REGEX.test(email)) throw new AuthError(400, 'Invalid email')
    if (password.length < MIN_PASSWORD_LENGTH)
      throw new AuthError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    if (!Number.isFinite(expendableAmountPerWeek) || expendableAmountPerWeek < 0)
      throw new AuthError(400, 'Invalid expendable amount')

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) throw new AuthError(409, 'Email already in use')

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST)

    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        expendableAmountPerWeek,
        role: 'user',
        categories: {
          create: STARTER_CATEGORIES,
        },
      },
    })

    const session = await this.createSession(user.id)

    return {
      user: toSessionUser(user),
      sessionId: session.id,
      expiresAt: session.expiresAt,
    }
  }

  async login(data: LoginRequest): Promise<AuthResult> {
    const email = data.email ? normalizeEmail(data.email) : ''
    const password = data.password ?? ''

    if (!email || !password) throw new AuthError(400, 'Email and password are required')

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) throw new AuthError(401, 'Invalid credentials')

    const ok = await bcrypt.compare(password, user.passwordHash)
    if (!ok) throw new AuthError(401, 'Invalid credentials')

    const session = await this.createSession(user.id)

    return {
      user: toSessionUser(user),
      sessionId: session.id,
      expiresAt: session.expiresAt,
    }
  }

  async logout(sessionId: string): Promise<void> {
    await prisma.session.deleteMany({ where: { id: sessionId } })
  }

  async getSessionUser(sessionId: string): Promise<SessionUser | null> {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    })

    if (!session) return null
    if (session.expiresAt.getTime() <= Date.now()) {
      await prisma.session.deleteMany({ where: { id: sessionId } })
      return null
    }

    return toSessionUser(session.user)
  }

  async updateProfile(userId: number, data: UpdateProfileRequest): Promise<SessionUser> {
    const update: { name?: string; expendableAmountPerWeek?: number } = {}

    if (data.name !== undefined) {
      const name = data.name.trim()
      if (!name) throw new AuthError(400, 'Name cannot be empty')
      update.name = name
    }

    if (data.expendableAmountPerWeek !== undefined) {
      const amount = Number(data.expendableAmountPerWeek)
      if (!Number.isFinite(amount) || amount < 0)
        throw new AuthError(400, 'Invalid expendable amount')
      update.expendableAmountPerWeek = amount
    }

    const user = await prisma.user.update({ where: { id: userId }, data: update })
    return toSessionUser(user)
  }

  private async createSession(userId: number) {
    const id = randomUUID()
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS)
    return prisma.session.create({ data: { id, userId, expiresAt } })
  }
}
