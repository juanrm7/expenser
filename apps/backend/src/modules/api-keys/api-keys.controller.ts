import type { FastifyPluginAsync } from 'fastify'
import type { Context } from '../../context.js'
import { requireSessionUser } from '../../lib/auth.js'
import { parse, parseId } from '../../lib/errors.js'
import { createApiKey, createApiKeyBody, listApiKeys, revokeApiKey } from './api-keys.service.js'

/** Managing keys needs a real login (`requireSessionUser`), so a leaked key can't mint or revoke keys. */
export function apiKeysController(ctx: Context): FastifyPluginAsync {
  return async (app) => {
    app.get('/api-keys', async (req) => {
      const user = await requireSessionUser(ctx, req)
      return listApiKeys(ctx, user.id)
    })

    app.post('/api-keys', async (req, reply) => {
      const user = await requireSessionUser(ctx, req)
      const created = await createApiKey(ctx, user.id, parse(createApiKeyBody, req.body))
      reply.status(201)
      return created
    })

    app.delete<{ Params: { id: string } }>('/api-keys/:id', async (req, reply) => {
      const user = await requireSessionUser(ctx, req)
      await revokeApiKey(ctx, user.id, parseId(req.params.id))
      return reply.status(204).send()
    })
  }
}
