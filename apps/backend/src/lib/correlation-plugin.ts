import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { randomUUID } from 'node:crypto'

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string
  }
}

const HEADER_NAME = 'x-correlation-id'

const correlationPluginAsync: FastifyPluginAsync = async (app) => {
  app.decorateRequest('correlationId', '')

  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers[HEADER_NAME]
    const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID()
    req.correlationId = id
    reply.header(HEADER_NAME, id)
  })
}

export const correlationPlugin = fp(correlationPluginAsync, { name: 'correlation-plugin' })
