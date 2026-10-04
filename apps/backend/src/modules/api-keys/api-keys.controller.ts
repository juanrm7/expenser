import type { FastifyInstance } from 'fastify'
import { ApiKeysService } from './api-keys.service.js'
import { ApiKeyError, type CreateApiKeyBody } from './api-keys.types.js'
import { requireSession } from '../../lib/auth-plugin.js'

const service = new ApiKeysService()

export async function apiKeysController(app: FastifyInstance) {
  // Managing keys needs a real login: a leaked key must not be able to mint or revoke keys.
  app.addHook('preHandler', requireSession)

  app.get('/api-keys', async (req) => {
    return service.getAll(req.user!.id)
  })

  app.post<{ Body: CreateApiKeyBody }>('/api-keys', async (req, reply) => {
    try {
      const created = await service.create(req.user!.id, req.body)
      return reply.status(201).send(created)
    } catch (err) {
      if (err instanceof ApiKeyError) return reply.status(err.status).send({ message: err.message })
      throw err
    }
  })

  app.delete<{ Params: { id: string } }>('/api-keys/:id', async (req, reply) => {
    const ok = await service.delete(req.user!.id, Number(req.params.id))
    if (!ok) return reply.status(404).send({ message: 'API key not found' })
    return reply.status(204).send()
  })
}
