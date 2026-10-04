import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { AuthService } from '../modules/auth/auth.service.js'
import { ApiKeysService } from '../modules/api-keys/api-keys.service.js'
import type { SessionUser } from '../modules/auth/auth.types.js'

export type AuthMethod = 'session' | 'apiKey'

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
    authMethod: AuthMethod | null
  }
}

const COOKIE_NAME = 'session_id'
const service = new AuthService()
const apiKeysService = new ApiKeysService()

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization
  if (!header) return null
  const [scheme, token] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : null
}

const authPluginAsync: FastifyPluginAsync = async (app) => {
  app.decorateRequest('user', null)
  app.decorateRequest('authMethod', null)

  // A session cookie (browser) takes precedence; otherwise accept `Authorization: Bearer <api key>`
  // (scripts, or Claude adding expenses for you).
  app.addHook('preHandler', async (req) => {
    req.user = null
    req.authMethod = null

    const sessionId = req.cookies?.[COOKIE_NAME]
    if (sessionId) {
      req.user = await service.getSessionUser(sessionId)
      if (req.user) {
        req.authMethod = 'session'
        return
      }
    }

    const token = bearerToken(req)
    if (token) {
      req.user = await apiKeysService.authenticate(token)
      if (req.user) req.authMethod = 'apiKey'
    }
  })
}

export const authPlugin = fp(authPluginAsync, { name: 'auth-plugin' })

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) {
    return reply.status(401).send({ message: 'Unauthorized' })
  }
}

/** Like requireAuth, but rejects API-key auth — for routes only a logged-in browser may use. */
export async function requireSession(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) {
    return reply.status(401).send({ message: 'Unauthorized' })
  }
  if (req.authMethod !== 'session') {
    return reply.status(403).send({ message: 'This action requires logging in, not an API key' })
  }
}
