import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { AuthService } from '../modules/auth/auth.service.js'
import type { SessionUser } from '../modules/auth/auth.types.js'

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
  }
}

const COOKIE_NAME = 'session_id'
const service = new AuthService()

const authPluginAsync: FastifyPluginAsync = async (app) => {
  app.decorateRequest('user', null)

  app.addHook('preHandler', async (req) => {
    const sessionId = req.cookies?.[COOKIE_NAME]
    if (!sessionId) {
      req.user = null
      return
    }
    req.user = await service.getSessionUser(sessionId)
  })
}

export const authPlugin = fp(authPluginAsync, { name: 'auth-plugin' })

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) {
    return reply.status(401).send({ message: 'Unauthorized' })
  }
}
