import type { FastifyInstance, FastifyReply } from 'fastify'
import { AuthService } from './auth.service.js'
import {
  AuthError,
  type LoginRequest,
  type SignupRequest,
  type UpdateProfileRequest,
} from './auth.types.js'
import { requireAuth } from '../../lib/auth-plugin.js'
import { env } from '../../lib/env.js'

const service = new AuthService()
const COOKIE_NAME = 'session_id'

function setSessionCookie(reply: FastifyReply, sessionId: string, expiresAt: Date) {
  reply.setCookie(COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: env.cookieSameSite,
    secure: env.cookieSecure,
    path: '/',
    expires: expiresAt,
  })
}

function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE_NAME, {
    path: '/',
    sameSite: env.cookieSameSite,
    secure: env.cookieSecure,
  })
}

export async function authController(app: FastifyInstance) {
  app.post<{ Body: SignupRequest }>('/auth/signup', async (req, reply) => {
    try {
      const result = await service.signup(req.body)
      setSessionCookie(reply, result.sessionId, result.expiresAt)
      return reply.status(201).send(result.user)
    } catch (err) {
      if (err instanceof AuthError) return reply.status(err.status).send({ message: err.message })
      throw err
    }
  })

  app.post<{ Body: LoginRequest }>('/auth/login', async (req, reply) => {
    try {
      const result = await service.login(req.body)
      setSessionCookie(reply, result.sessionId, result.expiresAt)
      return reply.send(result.user)
    } catch (err) {
      if (err instanceof AuthError) return reply.status(err.status).send({ message: err.message })
      throw err
    }
  })

  app.post('/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    const sessionId = req.cookies[COOKIE_NAME]
    if (sessionId) await service.logout(sessionId)
    clearSessionCookie(reply)
    return reply.status(204).send()
  })

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    return req.user!
  })

  app.patch<{ Body: UpdateProfileRequest }>(
    '/auth/me',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const user = await service.updateProfile(req.user!.id, req.body)
        return user
      } catch (err) {
        if (err instanceof AuthError) return reply.status(err.status).send({ message: err.message })
        throw err
      }
    }
  )
}
